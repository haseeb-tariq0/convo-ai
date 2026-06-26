"""Precompute the per-row / per-session signals that the dashboard widgets
otherwise derive by loading every row into Python (see docs/SCALING.md):

  - escalation_sentiment / is_in_house / has_booking_link  (session rule flags)
  - detected_language                                       (session language)
  - country                                                 (session phone-ISO)
  - faq_question                                            (normalized question)

The rules stay in ONE place — we reuse the exact functions the widgets use
(`classify_escalation`, `is_in_house`, `has_booking_link`, `detect_language`,
`country_iso_from_phone`, `_normalize_question`, `_is_faq_question`) — so the
cached values can never drift from the live logic. Each is denormalised onto
the rows so a simple `count(distinct session) filter (...)` / `group by`
reproduces the widget.

Verified to reproduce the widgets exactly on real data.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from .escalation import classify_escalation
from .language import detect_language
from .phone_country import country_iso_from_phone
from .session_flags import has_booking_link, is_in_house

_FAR_PAST = datetime.min.replace(tzinfo=timezone.utc)


def compute_session_flags(rows: list[Any]) -> dict[str, dict[str, Any]]:
    """Per-session signals, keyed by Session ID. Mirrors the widgets: only rows
    with both a Session ID and Content participate. `country` is the first valid
    phone-derived ISO in source-row order (matching the map widget's "first row
    per session" rule)."""
    by_session: dict[str, list[Any]] = defaultdict(list)
    for r in rows:
        sid = r.raw.get("Session ID")
        if sid and r.raw.get("Content"):
            by_session[sid].append(r)

    out: dict[str, dict[str, Any]] = {}
    for sid, rs in by_session.items():
        text = "\n".join(str(r.raw.get("Content")) for r in rs)
        ordered = sorted(rs, key=lambda r: r.occurred_at or _FAR_PAST)
        messages = [
            (str(r.raw.get("Role") or ""), str(r.raw.get("Content") or ""))
            for r in ordered
        ]
        # country: first valid phone-ISO in source-row order
        country = None
        for r in sorted(rs, key=lambda r: r.source_row_index):
            iso = country_iso_from_phone(r.raw.get("User Phone"))
            if iso:
                country = iso
                break
        out[sid] = {
            "escalation_sentiment": classify_escalation(messages),
            "is_in_house": is_in_house(text),
            "has_booking_link": has_booking_link(text),
            "detected_language": detect_language(text),
            "country": country,
        }
    return out


def row_flag_updates(rows: list[Any]) -> list[dict[str, Any]]:
    """Per-row update dicts ready for a bulk upsert. Session signals are copied
    onto every row of the session; `faq_question` is per-row (the normalized
    question for user rows that look like FAQs, else null)."""
    from .aggregations import _is_faq_question, _normalize_question  # lazy, avoids import cycle

    session_flags = compute_session_flags(rows)
    updates: list[dict[str, Any]] = []
    for r in rows:
        f = session_flags.get(r.raw.get("Session ID")) or {}
        faq_q = None
        if str(r.raw.get("Role") or "").lower() == "user":
            content = str(r.raw.get("Content") or "").strip()
            if content:
                norm = _normalize_question(content)
                if _is_faq_question(norm):
                    faq_q = norm
        updates.append(
            {
                "id": r.id,
                "escalation_sentiment": f.get("escalation_sentiment"),
                "is_in_house": bool(f.get("is_in_house", False)),
                "has_booking_link": bool(f.get("has_booking_link", False)),
                "detected_language": f.get("detected_language"),
                "country": f.get("country"),
                "faq_question": faq_q,
            }
        )
    return updates
