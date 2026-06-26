"""Field aggregation — turns raw chat_rows + ga4 snapshots into the shape
the frontend's FieldRenderer expects.

SPEC §7 lists the v1 field types:
  metric | gauge | line | bar | pie | tag_cloud | table

Each `compute_<type>` function returns a JSON-serialisable dict the frontend
maps onto the matching chart component. Unknown types fall through to
{"error": "unsupported field type"} — the frontend renders that as a
placeholder, per SPEC §7's "Unknown types render as 'Unsupported field type'
instead of crashing" rule.
"""
from __future__ import annotations

import re
import threading
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

# Leading politeness phrases to strip when normalizing FAQ questions so
# "please tell me what time is breakfast" and "what time is breakfast"
# bucket together.
_FAQ_FILLERS = [
    "could you please tell me ",
    "could you tell me ",
    "can you please tell me ",
    "can you tell me ",
    "please tell me ",
    "tell me ",
    "i'd like to know ",
    "i want to know ",
    "do you know ",
    "could you please ",
    "could you ",
    "can you ",
    "please ",
    "hi ",
    "hello ",
    "hey ",
]
_FAQ_QUESTION_STARTERS = {
    # English
    "what", "when", "how", "where", "why", "who", "can", "could", "would",
    "do", "does", "did", "is", "are", "was", "were", "will", "should",
    # Arabic
    "اين", "متى", "كيف", "لماذا", "كم", "هل", "ماذا", "ما",
}


def _normalize_question(text: str) -> str:
    # Strip markdown decoration, lowercase, collapse whitespace.
    t = re.sub(r"[*_`]+", "", text or "").lower().strip()
    t = re.sub(r"\s+", " ", t)
    # Strip leading politeness fillers, iteratively (handles stacked fillers
    # like "hi please can you tell me how much...").
    changed = True
    while changed:
        changed = False
        for f in _FAQ_FILLERS:
            if t.startswith(f):
                t = t[len(f):]
                changed = True
                break
    # Strip trailing junk except question marks.
    t = t.rstrip(".,!:;- ")
    return t


def _is_faq_question(text: str) -> bool:
    if not text or len(text) < 4 or len(text) > 200:
        return False
    if text.endswith("?") or text.endswith("؟"):
        return True
    first_word = text.split(" ", 1)[0]
    return first_word in _FAQ_QUESTION_STARTERS

from ..store import ChatRow, GA4Integration, GA4Snapshot, store
from .escalation import classify_escalation
from .language import detect_language
from .phone_country import country_iso_from_phone
from .session_flags import has_booking_link, is_in_house


# ---- chat-row sourced fields ------------------------------------------------

def _within_window(
    rows: list[ChatRow],
    days: int | None,
    *,
    from_dt: datetime | None = None,
    to_dt: datetime | None = None,
) -> list[ChatRow]:
    """Filter chat rows by time.

    Three modes:
      1. Explicit `from_dt` / `to_dt` — keep rows where
         `from_dt <= occurred_at <= to_dt`. Either bound may be None for
         open-ended (used internally by the dashboard route).
      2. `days` — keep rows where `occurred_at >= now() - days`.
         Backwards-compatible with the original API.
      3. None — return everything.
    """
    if from_dt is not None or to_dt is not None:
        return [
            r for r in rows
            if r.occurred_at is not None
            and (from_dt is None or r.occurred_at >= from_dt)
            and (to_dt is None or r.occurred_at <= to_dt)
        ]
    if not days:
        return rows
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    return [r for r in rows if r.occurred_at and r.occurred_at >= cutoff]


def _prev_window(
    rows: list[ChatRow],
    days: int | None,
    *,
    from_dt: datetime | None = None,
    to_dt: datetime | None = None,
) -> list[ChatRow]:
    """Return the period IMMEDIATELY PRECEDING the one `_within_window`
    would return — same length, shifted back. Used to compute the prev-
    period comparison values that drive the KPI ribbon's delta arrows
    and the volume chart's dashed comparison line.

    Examples:
      - `days=7` returns rows in [now-14d, now-7d].
      - `from_dt=Jan 15, to_dt=Jan 22` returns rows in [Jan 8, Jan 15).
    """
    if from_dt is not None or to_dt is not None:
        if from_dt is None or to_dt is None:
            return []
        span = to_dt - from_dt
        prev_to = from_dt
        prev_from = from_dt - span
        return [
            r for r in rows
            if r.occurred_at is not None
            and prev_from <= r.occurred_at < prev_to
        ]
    if not days:
        return []
    now = datetime.now(timezone.utc)
    end = now - timedelta(days=days)
    start = end - timedelta(days=days)
    return [
        r for r in rows
        if r.occurred_at and start <= r.occurred_at < end
    ]


def _session_texts(rows: list[ChatRow]) -> dict[str, str]:
    """Concatenate every message's Content per session, joined by newline.
    Used by the keyword-based per-session flags (in-house, booking link)
    so they can scan the whole conversation, not individual rows."""
    by_session: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        sid = r.raw.get("Session ID")
        content = r.raw.get("Content")
        if sid and content:
            by_session[sid].append(str(content))
    return {sid: "\n".join(texts) for sid, texts in by_session.items()}


def _escalated_sessions(rows: list[ChatRow]) -> dict[str, str]:
    """Group `rows` by Session ID, run the escalation classifier per session,
    return `{session_id: "Positive"|"Negative"|"Unknown"}` for escalated
    sessions only. Sessions with no trigger phrase are omitted from the dict.
    """
    by_session: dict[str, list[ChatRow]] = defaultdict(list)
    for r in rows:
        sid = r.raw.get("Session ID")
        if sid and r.raw.get("Content"):
            by_session[sid].append(r)
    out: dict[str, str] = {}
    _far_past = datetime.min.replace(tzinfo=timezone.utc)
    for sid, rs in by_session.items():
        rs.sort(key=lambda r: r.occurred_at or _far_past)
        messages = [
            (str(r.raw.get("Role") or ""), str(r.raw.get("Content") or ""))
            for r in rs
        ]
        sentiment = classify_escalation(messages)
        if sentiment is not None:
            out[sid] = sentiment
    return out


def _ga4_within_window(
    snaps: list[GA4Snapshot],
    days: int | None,
    *,
    from_date_: date | None = None,
    to_date_: date | None = None,
) -> list[GA4Snapshot]:
    """Filter GA4 snapshots by date. Same precedence rules as
    `_within_window`: explicit from/to wins, else relative days, else all."""
    if from_date_ is not None or to_date_ is not None:
        f_iso = from_date_.isoformat() if from_date_ else None
        t_iso = to_date_.isoformat() if to_date_ else None
        return [
            s for s in snaps
            if (f_iso is None or s.date >= f_iso)
            and (t_iso is None or s.date <= t_iso)
        ]
    if not days:
        return snaps
    cutoff = (date.today() - timedelta(days=days)).isoformat()
    return [s for s in snaps if s.date >= cutoff]


def compute_metric(rows: list[ChatRow], field: dict, ga4_snaps: list[GA4Snapshot]) -> dict:
    """`type: metric` → a single number with optional sub-label."""
    source = field.get("source")
    window = field.get("window_days")

    if source == "ga4":
        metric_type = field.get("metric_type")
        # "bookings" is just a count roll-up of conversion events — same
        # source data, different label. Hospitality clients want both tiles.
        snapshot_metric = "conversions" if metric_type == "bookings" else metric_type
        snaps = [s for s in ga4_snaps if s.metric_type == snapshot_metric]
        if window:
            cutoff = (date.today() - timedelta(days=window)).isoformat()
            snaps = [s for s in snaps if s.date >= cutoff]
        # Pick the natural roll-up per metric type.
        if metric_type == "users":
            value = sum(s.data.get("active_users", 0) for s in snaps)
            return {"value": value, "unit": "users", "window_days": window}
        if metric_type == "pageviews":
            value = sum(s.data.get("views", 0) for s in snaps)
            return {"value": value, "unit": "views", "window_days": window}
        if metric_type == "conversions":
            revenue_aed = sum(s.data.get("revenue_aed", 0.0) for s in snaps)
            conversions = sum(s.data.get("conversions", 0) for s in snaps)
            # AED is pegged to USD at ~3.6725, so 1 AED ≈ 0.2723 USD.
            currency = str(field.get("currency") or "AED").upper()
            if currency == "USD":
                value = round(revenue_aed * 0.2723, 2)
                unit = "USD"
            else:
                value = round(revenue_aed, 2)
                unit = "AED"
            return {
                "value": value,
                "unit": unit,
                "sublabel": f"{conversions} conversions",
                "window_days": window,
            }
        if metric_type == "bookings":
            # Bookings = the count of conversion events. Same source as
            # revenue, different roll-up. Hospitality clients want both.
            conversions = sum(s.data.get("conversions", 0) for s in snaps)
            return {"value": conversions, "unit": "bookings", "window_days": window}
        return {"value": len(snaps), "unit": "snapshots", "window_days": window}

    # chat-row metrics. NOTE: `rows` is already windowed by the caller in
    # compute_dashboard_data — once for the current period and once for the
    # immediately-preceding period (when computing delta). Re-filtering here
    # with `_within_window(rows, window)` would silently drop the prev rows
    # (their anchor is the prev-period end, not `now()`), zeroing every
    # delta against an empty baseline. So trust the caller's windowing.
    windowed = rows
    if source == "chat_count":
        return {"value": len(windowed), "unit": "chats", "window_days": window}
    if source == "human_escalations":
        # Real definition (ported from Rove Apps Script): a session is
        # "escalated" if any message contains a trigger phrase like "speak
        # to human", "manager", "callback". Counts sessions, not messages.
        sessions = _escalated_sessions(windowed)
        return {"value": len(sessions), "unit": "escalations", "window_days": window}
    if source == "escalated_by_sentiment":
        # Buckets the escalated sessions by the script's 2-line-back context
        # sentiment scan: Negative wins ties; Positive otherwise; Unknown
        # if neither side matches. Accepts {Positive | Negative | Unknown}
        # (also `neutral` as an alias for Unknown so old tile configs work).
        target_raw = str(field.get("sentiment") or "").lower()
        bucket = {
            "positive": "Positive",
            "negative": "Negative",
            "neutral": "Unknown",
            "unknown": "Unknown",
        }.get(target_raw, target_raw.title())
        sessions = _escalated_sessions(windowed)
        v = sum(1 for sent in sessions.values() if sent == bucket)
        return {"value": v, "unit": target_raw or "escalations", "window_days": window}
    if source == "keyword_count":
        # Admin-defined custom metric. Counts rows whose message text contains
        # any of the configured keywords (case-insensitive substring match).
        # `content_field` defaults to "Content" — the seed uses that key.
        keywords = field.get("keywords") or []
        keywords_lower = [str(k).lower() for k in keywords if str(k).strip()]
        if not keywords_lower:
            return {"value": 0, "unit": "mentions", "window_days": window, "keywords": []}
        content_field = field.get("content_field", "Content")
        def _matches(r: ChatRow) -> bool:
            text = r.raw.get(content_field) or r.raw.get(content_field.lower()) or ""
            text = str(text).lower()
            return any(k in text for k in keywords_lower)
        count = sum(1 for r in windowed if _matches(r))
        return {"value": count, "unit": "mentions", "window_days": window, "keywords": keywords}
    if source == "user_messages":
        v = sum(1 for r in windowed if str(r.raw.get("Role") or "").lower() == "user")
        return {"value": v, "unit": "user msgs", "window_days": window}
    if source == "chat_sessions":
        # A "chat" is a distinct Session ID. Real chat count, not message count.
        sessions = {r.raw.get("Session ID") for r in windowed if r.raw.get("Session ID")}
        return {"value": len(sessions), "unit": "chats", "window_days": window}
    if source == "unique_users":
        # Pick the best identifier per row: email → phone → name → session.
        # Falls back to Session ID so we don't undercount when end-user info
        # is empty (common in this dataset).
        ids: set[str] = set()
        for r in windowed:
            ident = (
                r.raw.get("User Email")
                or r.raw.get("User Phone")
                or r.raw.get("User Name")
                or r.raw.get("Session ID")
            )
            if ident:
                ids.add(str(ident))
        return {"value": len(ids), "unit": "users", "window_days": window}
    if source == "avg_messages_per_chat":
        per_session: dict[str, int] = defaultdict(int)
        for r in windowed:
            sid = r.raw.get("Session ID")
            if sid:
                per_session[sid] += 1
        avg = sum(per_session.values()) / len(per_session) if per_session else 0
        return {"value": round(avg, 1), "unit": "msgs/chat", "window_days": window}
    if source == "in_house_guests":
        # Count sessions whose conversation log indicates the user is
        # currently a guest at the hotel (mentions a room number, "checked
        # in today", etc.). Ported from the Apps Script's in-house rule.
        texts = _session_texts(windowed)
        count = sum(1 for text in texts.values() if is_in_house(text))
        return {"value": count, "unit": "in-house", "window_days": window}
    if source == "booking_links_shared":
        # Count sessions where a booking link (URL, OTA name, or referral
        # phrase) appears anywhere in the conversation.
        texts = _session_texts(windowed)
        count = sum(1 for text in texts.values() if has_booking_link(text))
        return {"value": count, "unit": "links shared", "window_days": window}
    if source == "avg_response_time_seconds":
        # Group rows by session, sort by timestamp, find each User→Assistant
        # transition, take the delta. Ignore gaps over 10 min (likely the
        # user came back later, not the bot's response time).
        by_session: dict[str, list[ChatRow]] = defaultdict(list)
        for r in windowed:
            sid = r.raw.get("Session ID")
            if sid and r.occurred_at:
                by_session[sid].append(r)
        deltas: list[float] = []
        for rs in by_session.values():
            rs.sort(key=lambda r: r.occurred_at)
            for i in range(1, len(rs)):
                prev, curr = rs[i - 1], rs[i]
                if (
                    str(prev.raw.get("Role") or "").lower() == "user"
                    and str(curr.raw.get("Role") or "").lower() == "assistant"
                ):
                    dt = (curr.occurred_at - prev.occurred_at).total_seconds()
                    if 0 <= dt <= 600:
                        deltas.append(dt)
        avg = sum(deltas) / len(deltas) if deltas else 0
        return {"value": round(avg, 1), "unit": "seconds", "window_days": window}
    return {"value": len(windowed), "unit": "rows", "window_days": window}


def compute_gauge(rows: list[ChatRow], field: dict, ga4_snaps: list[GA4Snapshot]) -> dict:
    """`type: gauge` → a single -1..1 (or 0..1) value for an arc gauge."""
    if field.get("source") == "ai_sentiment_score":
        scored = [r.ai_sentiment_score for r in rows if r.ai_sentiment_score is not None]
        avg = sum(scored) / len(scored) if scored else 0.0
        return {"value": round(avg, 3), "min": -1.0, "max": 1.0}
    return {"value": 0.0, "min": -1.0, "max": 1.0}


def compute_line(rows: list[ChatRow], field: dict, ga4_snaps: list[GA4Snapshot]) -> dict:
    """`type: line` → ordered list of (label, value) points."""
    agg = field.get("aggregation", "count_by_day")
    if field.get("source") == "ga4":
        metric_type = field.get("metric_type")
        snaps = sorted([s for s in ga4_snaps if s.metric_type == metric_type], key=lambda s: s.date)
        if metric_type == "users":
            points = [{"x": s.date, "y": s.data.get("active_users", 0)} for s in snaps]
        elif metric_type == "pageviews":
            points = [{"x": s.date, "y": s.data.get("views", 0)} for s in snaps]
        elif metric_type == "conversions":
            points = [{"x": s.date, "y": s.data.get("revenue_aed", 0)} for s in snaps]
        else:
            points = [{"x": s.date, "y": 0} for s in snaps]
        return {"points": points}

    if agg == "count_by_day":
        counts: dict[str, int] = defaultdict(int)
        for r in rows:
            if not r.occurred_at:
                continue
            day = r.occurred_at.date().isoformat()
            counts[day] += 1
        ordered = sorted(counts.items())
        return {"points": [{"x": d, "y": c} for d, c in ordered]}

    if agg == "sessions_by_day":
        # Distinct Session IDs per day — a real "conversations/sessions over
        # time" trend, not a message-volume trend (per the 6/9 review).
        seen: dict[str, set] = defaultdict(set)
        for r in rows:
            sid = r.raw.get("Session ID")
            if not r.occurred_at or not sid:
                continue
            seen[r.occurred_at.date().isoformat()].add(sid)
        ordered = sorted(seen.items())
        return {"points": [{"x": d, "y": len(s)} for d, s in ordered]}

    return {"points": []}


def compute_bar(rows: list[ChatRow], field: dict, ga4_snaps: list[GA4Snapshot]) -> dict:
    """`type: bar` → categories with values. Defaults to channel breakdown."""
    by = field.get("group_by", "Channel")
    if field.get("source") == "language":
        # Detect once per session (full conversation log), aggregate. Mirrors
        # Rove's "Languages" horizontal bar in the Looker Studio dashboard.
        texts = _session_texts(rows)
        counts: Counter = Counter(detect_language(t) for t in texts.values())
        return {"bars": [{"label": k, "value": v} for k, v in counts.most_common()]}
    if field.get("source") == "ga4_traffic":
        snaps = [s for s in ga4_snaps if s.metric_type == "traffic"]
        totals: Counter = Counter()
        for s in snaps:
            for src, n in (s.data.get("sources") or {}).items():
                totals[src] += n
        return {"bars": [{"label": k, "value": v} for k, v in totals.most_common()]}

    counts: Counter = Counter()
    for r in rows:
        v = r.raw.get(by) or r.raw.get(by.lower())
        if v:
            counts[str(v)] += 1
    return {"bars": [{"label": k, "value": v} for k, v in counts.most_common()]}


def compute_pie(rows: list[ChatRow], field: dict, ga4_snaps: list[GA4Snapshot]) -> dict:
    """`type: pie` → slices. Defaults to language distribution (the example
    Mohsin highlighted in the meeting)."""
    by = field.get("group_by", "Language")
    if field.get("source") == "language":
        texts = _session_texts(rows)
        counts = Counter(detect_language(t) for t in texts.values())
        total = sum(counts.values()) or 1
        return {
            "slices": [
                {"label": k, "value": v, "pct": round(v / total * 100, 1)}
                for k, v in counts.most_common()
            ]
        }
    if field.get("source") == "ai_intent":
        counts = Counter(r.ai_intent for r in rows if r.ai_intent)
    else:
        counts = Counter()
        for r in rows:
            v = r.raw.get(by) or r.raw.get(by.lower())
            if v:
                counts[str(v)] += 1
    total = sum(counts.values()) or 1
    return {
        "slices": [
            {"label": k, "value": v, "pct": round(v / total * 100, 1)}
            for k, v in counts.most_common()
        ]
    }


def compute_tag_cloud(rows: list[ChatRow], field: dict, ga4_snaps: list[GA4Snapshot]) -> dict:
    """`type: tag_cloud` → topic frequencies from AI labels."""
    counts: Counter = Counter()
    for r in rows:
        for t in r.ai_topics or []:
            counts[t] += 1
    return {"tags": [{"label": k, "weight": v} for k, v in counts.most_common(40)]}


def compute_table(rows: list[ChatRow], field: dict, ga4_snaps: list[GA4Snapshot]) -> dict:
    """`type: table` → recent rows for an at-a-glance feed.

    The `columns` field config drives both the displayed header order AND
    which cells are pulled. Special-cased column names:
      - "Timestamp" → r.occurred_at (ISO)
      - "ai_sentiment" / "ai_intent" / "ai_topics" → the AI attributes
    Anything else is looked up in `r.raw` by exact key, with a lowercase
    fallback (so "Source" finds "source" too).

    Special `source: "faq_questions"` mode mirrors Rove's "FAQ Analysis"
    table — extracts user-role messages that look like questions, normalizes
    them (lowercase + strip filler/markdown), buckets identical normalized
    forms, returns top-N by occurrence.
    """
    if field.get("source") == "faq_questions":
        return _compute_faq_table(rows, field)
    if field.get("source") == "ga4_revenue":
        return _compute_ga4_revenue_table(field, ga4_snaps)
    limit = int(field.get("limit", 20))
    ordered = sorted(
        rows,
        key=lambda r: r.occurred_at or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )[:limit]
    columns = field.get("columns") or [
        "Timestamp", "Channel", "Language", "Message", "ai_sentiment", "ai_intent",
    ]
    body = []
    for r in ordered:
        cells: dict[str, Any] = {}
        for col in columns:
            if col == "Timestamp":
                cells[col] = r.occurred_at.isoformat() if r.occurred_at else None
            elif col == "ai_sentiment":
                cells[col] = r.ai_sentiment
            elif col == "ai_intent":
                cells[col] = r.ai_intent
            elif col == "ai_topics":
                cells[col] = r.ai_topics
            else:
                cells[col] = r.raw.get(col) or r.raw.get(col.lower())
        body.append(cells)
    return {"columns": columns, "rows": body}


def _compute_ga4_revenue_table(field: dict, ga4_snaps: list[GA4Snapshot]) -> dict:
    """Mirrors Rove's GA4 Analysis table — one row per day with revenue
    (AED) and conversion count, sorted by revenue desc.
    """
    limit = int(field.get("limit", 100))
    snaps = [s for s in ga4_snaps if s.metric_type == "conversions"]
    body = [
        {
            "Date": s.date,
            "Revenue (AED)": round(float(s.data.get("revenue_aed", 0)), 2),
            "Conversions": int(s.data.get("conversions", 0)),
        }
        for s in snaps
    ]
    body.sort(key=lambda r: r["Revenue (AED)"], reverse=True)
    return {"columns": ["Date", "Revenue (AED)", "Conversions"], "rows": body[:limit]}


def _compute_faq_table(rows: list[ChatRow], field: dict) -> dict:
    limit = int(field.get("limit", 20))
    # Map normalized question → (display form, count). The first time we
    # see a normalized question, capture the original (title-cased) form for
    # display so the table doesn't read as all-lowercase.
    # Count DISTINCT conversations that asked each question, not raw message
    # occurrences — a templated question repeated within/across messages
    # shouldn't read as "asked 126 times" (per the 6/9 review). One session
    # asking it many times counts once.
    sessions_by_q: dict[str, set] = defaultdict(set)
    display: dict[str, str] = {}
    for r in rows:
        if str(r.raw.get("Role") or "").lower() != "user":
            continue
        raw_text = str(r.raw.get("Content") or "").strip()
        if not raw_text:
            continue
        norm = _normalize_question(raw_text)
        if not _is_faq_question(norm):
            continue
        sid = r.raw.get("Session ID") or r.id
        sessions_by_q[norm].add(sid)
        if norm not in display:
            # Mild title-case: capitalize first letter, ensure trailing ?.
            disp = norm[0].upper() + norm[1:]
            if not (disp.endswith("?") or disp.endswith("؟")):
                disp += "?"
            display[norm] = disp
    ranked = sorted(sessions_by_q.items(), key=lambda kv: len(kv[1]), reverse=True)[:limit]
    body = [
        {"Question": display[norm], "Conversations": len(sids)}
        for norm, sids in ranked
    ]
    return {"columns": ["Question", "Conversations"], "rows": body}


def compute_map(rows: list[ChatRow], field: dict, ga4_snaps: list[GA4Snapshot]) -> dict:
    """`type: map` has two modes:

    1. `source: "ga4_country"` → world bubble map of users by country, sourced
       from GA4 country snapshots aggregated over the active window.
    2. default (anything else) → single-pin Google Maps embed iframe driven
       by the configured `q` place query. No API key needed.
    """
    source = field.get("source")
    if source == "ga4_country":
        snaps = [s for s in ga4_snaps if s.metric_type == "country"]
        totals: Counter = Counter()
        for s in snaps:
            for iso, n in (s.data.get("countries") or {}).items():
                totals[iso] += int(n)
        points = [{"country": iso, "value": v} for iso, v in totals.most_common()]
        return {"points": points, "total": sum(totals.values())}
    if source == "phone_country":
        # Real chat origin — derive country from each row's User Phone prefix
        # (WhatsApp rows only carry phones; APP/BUILDER/VOICE rows are skipped).
        # Counts distinct sessions per country, not raw messages, so a chatty
        # user from UAE doesn't outweigh a quiet one from India.
        per_session: dict[str, str] = {}
        for r in rows:
            sid = r.raw.get("Session ID")
            if not sid or sid in per_session:
                continue
            iso = country_iso_from_phone(r.raw.get("User Phone"))
            if iso:
                per_session[sid] = iso
        totals = Counter(per_session.values())
        points = [{"country": iso, "value": v} for iso, v in totals.most_common()]
        return {"points": points, "total": sum(totals.values())}
    return {
        "q": field.get("q", ""),
        "zoom": field.get("zoom"),
    }


def compute_big_number(rows, field, ga4_snaps) -> dict:
    """Same as metric but with optional sparkline. Set `with_sparkline:
    true` on the field config to include a `sparkline: list[int]` of
    daily counts over the window (computed via count_by_day on the
    windowed rows; only meaningful for chat-source metrics)."""
    base = compute_metric(rows, field, ga4_snaps)
    if field.get("with_sparkline") and field.get("source") != "ga4":
        # Reuse the line-chart day-bucketing logic
        from collections import defaultdict
        counts: dict[str, int] = defaultdict(int)
        for r in rows:
            if not r.occurred_at:
                continue
            counts[r.occurred_at.date().isoformat()] += 1
        ordered = sorted(counts.items())
        base["sparkline"] = [c for _, c in ordered]
    return base


def compute_donut(rows, field, ga4_snaps) -> dict:
    """Same shape as `pie`, with an extra `center_label` string for the
    widget's hole. The renderer shows the slice total + this label."""
    base = compute_pie(rows, field, ga4_snaps)
    base["center_label"] = field.get("center_label", "total")
    base["total"] = sum(s["value"] for s in base.get("slices", []))
    return base


def compute_funnel(rows, field, ga4_snaps) -> dict:
    """Multi-stage funnel. `stages` is a list of metric-style configs:
    [{"label": "Visits", "source": "chat_count", "window_days": 7}, ...]
    Each stage is computed via compute_metric, then we attach
    `pct_of_top` (percentage of the first stage's value)."""
    stages = field.get("stages", []) or []
    out_stages = []
    top_value: float | None = None
    for s in stages:
        stage_cfg = {"type": "metric", **s}
        val = compute_metric(rows, stage_cfg, ga4_snaps)
        v = val.get("value", 0)
        if not isinstance(v, (int, float)):
            v = 0
        if top_value is None:
            top_value = float(v) if v else None
        pct = (float(v) / top_value * 100) if top_value else 0
        out_stages.append({
            "label": s.get("label", s.get("source", "stage")),
            "value": v,
            "pct_of_top": round(pct, 1),
        })
    return {"stages": out_stages}


def compute_progress_bar(rows, field, ga4_snaps) -> dict:
    """Single value + target. Renders as a filled bar reaching pct of
    its width. `target` defaults to 100. `direction: 'lower_is_better'`
    flips the color tone (e.g. response time)."""
    base = compute_metric(rows, field, ga4_snaps)
    v = base.get("value", 0)
    if not isinstance(v, (int, float)):
        v = 0
    target = field.get("target", 100)
    try:
        target = float(target)
    except (TypeError, ValueError):
        target = 100
    pct = (float(v) / target * 100) if target else 0
    return {
        "value": v,
        "target": target,
        "unit": base.get("unit"),
        "pct": min(100, max(0, pct)),
        "direction": field.get("direction", "higher_is_better"),
    }


_DISPATCH = {
    "metric": compute_metric,
    "gauge": compute_gauge,
    "line": compute_line,
    "bar": compute_bar,
    "pie": compute_pie,
    "tag_cloud": compute_tag_cloud,
    "table": compute_table,
    "map": compute_map,
    "big_number": compute_big_number,
    "donut": compute_donut,
    "funnel": compute_funnel,
    "progress_bar": compute_progress_bar,
}


def compute_field(field: dict, rows: list[ChatRow], ga4_snaps: list[GA4Snapshot]) -> Any:
    type_ = field.get("type")
    fn = _DISPATCH.get(type_)
    if not fn:
        return {"error": f"unsupported field type: {type_}"}
    return fn(rows, field, ga4_snaps)


# Channel filter. The 6/9 review asked for WhatsApp-only, but that was based on
# the mock data's channel mix — real conversations actually arrive tagged "APP"
# (the bot platform's source), so filtering to WhatsApp throws away real data.
# Disabled (""). Set to a substring (e.g. "whatsapp") to re-enable per need.
_CHANNEL_KEEP = ""


def _whatsapp_only(rows: list[ChatRow]) -> list[ChatRow]:
    if not _CHANNEL_KEEP:
        return rows
    kept = [
        r for r in rows
        if _CHANNEL_KEEP in str(r.raw.get("Source") or r.raw.get("Channel") or "").lower()
    ]
    # Safety: if filtering would empty the dashboard (a client whose Source
    # column uses different values), keep everything rather than show nothing.
    return kept if kept else rows


# ── Result cache ───────────────────────────────────────────────────────────
# compute_dashboard_data loads ALL of a dashboard's rows and aggregates them.
# A public dashboard open in a browser (or several) re-hits /data repeatedly;
# without a cache, every hit independently loads ~9k rows + recomputes, and the
# concurrent copies are what pushed the backend past Render's memory limit.
# A short TTL means at most one compute per dashboard+window per _CACHE_TTL
# seconds, and a per-key lock collapses a burst of concurrent requests into a
# single compute (no thundering herd). Data is at most _CACHE_TTL seconds stale
# — fine, since the on-screen refresh indicator is already a ~30s cosmetic.
_CACHE_TTL = 45.0  # seconds
_CACHE_MAX = 200   # hard cap on distinct keys, to bound memory
_cache: dict[tuple, tuple[float, dict]] = {}
_cache_guard = threading.Lock()          # guards _cache + _key_locks
_key_locks: dict[tuple, threading.Lock] = {}


def clear_aggregation_cache() -> None:
    """Drop all cached results. Called by the test fixture on store reset, and
    available if a forced refresh is ever needed."""
    with _cache_guard:
        _cache.clear()
        _key_locks.clear()


def compute_dashboard_data(
    dashboard_id: str,
    range_days: int | None = None,
    *,
    from_date: date | None = None,
    to_date: date | None = None,
) -> dict:
    """Cached wrapper around the aggregation. See _compute_dashboard_data_uncached
    for the actual computation; this layer just memoizes the result for
    _CACHE_TTL seconds to keep memory and CPU bounded under repeated/concurrent
    dashboard views."""
    key = (dashboard_id, range_days, from_date, to_date)
    now = time.monotonic()
    with _cache_guard:
        hit = _cache.get(key)
        if hit and now - hit[0] < _CACHE_TTL:
            return hit[1]
        klock = _key_locks.setdefault(key, threading.Lock())

    # Only one thread computes a given key at a time; the rest wait here and
    # then read the value the winner just cached.
    with klock:
        now = time.monotonic()
        with _cache_guard:
            hit = _cache.get(key)
            if hit and now - hit[0] < _CACHE_TTL:
                return hit[1]
        # SQL path (Postgres aggregation) when enabled AND the store supports it
        # (the Supabase backend); otherwise the in-Python path. Gated so we can
        # flip per-deployment after verifying.
        from ..config import get_settings
        _s = get_settings()
        if _s.use_rollup_aggregation and hasattr(store, "rollup_aggregates"):
            result = compute_dashboard_data_sql(
                dashboard_id, range_days, from_date=from_date, to_date=to_date, use_rollup=True
            )
        elif _s.use_sql_aggregation and hasattr(store, "core_aggregates"):
            result = compute_dashboard_data_sql(
                dashboard_id, range_days, from_date=from_date, to_date=to_date
            )
        else:
            result = _compute_dashboard_data_uncached(
                dashboard_id, range_days, from_date=from_date, to_date=to_date
            )
        with _cache_guard:
            if len(_cache) >= _CACHE_MAX:
                _cache.clear()
                _key_locks.clear()
                klock = _key_locks.setdefault(key, klock)
            _cache[key] = (time.monotonic(), result)
        return result


def _compute_dashboard_data_uncached(
    dashboard_id: str,
    range_days: int | None = None,
    *,
    from_date: date | None = None,
    to_date: date | None = None,
) -> dict:
    """Top-level entrypoint called by the public router.

    Windowing precedence:
      1. `from_date` + `to_date` — explicit historical range. Fields with
         their own pinned `window_days` (e.g. "Chats today") still honor
         the pin, because those metrics are definition-locked.
      2. `range_days` — chip / preset selection. Same pinning rule.
      3. None — show everything for unpinned fields.
    """
    d = store.get_dashboard(dashboard_id)
    if not d:
        return {"fields": [], "generated_at": datetime.now(timezone.utc)}
    all_rows = _whatsapp_only(store.chat_rows_for_dashboard(dashboard_id))
    ga4 = store.get_ga4_for_client(d.client_id)
    all_snaps = store.snapshots_for_integration(ga4.id) if ga4 else []

    # Resolve the from/to into timezone-aware datetimes once. from_date is
    # interpreted as the start of the day (UTC); to_date as the end of the
    # day, so the range is inclusive on both ends.
    from_dt = (
        datetime.combine(from_date, datetime.min.time()).replace(tzinfo=timezone.utc)
        if from_date
        else None
    )
    to_dt = (
        datetime.combine(to_date, datetime.max.time()).replace(tzinfo=timezone.utc)
        if to_date
        else None
    )
    has_explicit_range = from_dt is not None or to_dt is not None

    out_fields = []
    for f in d.field_config:
        pinned = f.get("window_days")
        # Compute current-window rows AND the immediately-previous window
        # (same length, shifted back). The previous window powers the
        # KPI delta arrows + the volume chart's dashed comparison line.
        if pinned:
            rows = _within_window(all_rows, pinned)
            prev_rows = _prev_window(all_rows, pinned)
            snaps = _ga4_within_window(all_snaps, pinned)
            f_eff = {**f, "window_days": pinned}
            effective_days_for_prev = pinned
        elif has_explicit_range:
            rows = _within_window(all_rows, None, from_dt=from_dt, to_dt=to_dt)
            prev_rows = _prev_window(all_rows, None, from_dt=from_dt, to_dt=to_dt)
            snaps = _ga4_within_window(all_snaps, None, from_date_=from_date, to_date_=to_date)
            if from_date and to_date:
                approx = max(1, (to_date - from_date).days + 1)
                f_eff = {**f, "window_days": approx}
                effective_days_for_prev = approx
            else:
                f_eff = f
                effective_days_for_prev = None
        else:
            rows = _within_window(all_rows, range_days)
            prev_rows = _prev_window(all_rows, range_days)
            snaps = _ga4_within_window(all_snaps, range_days)
            f_eff = {**f, "window_days": range_days} if range_days else f
            effective_days_for_prev = range_days

        value = compute_field(f_eff, rows, snaps)

        # Decorate metric + line values with prev-period data so the
        # frontend can show deltas / a comparison line. We only do the
        # extra pass when there's actually a window (otherwise "previous"
        # is undefined).
        if isinstance(value, dict) and effective_days_for_prev and not value.get("error"):
            field_type = f.get("type")
            if field_type == "metric" and prev_rows is not None:
                prev_value = compute_field(f_eff, prev_rows, snaps)
                if isinstance(prev_value, dict) and not prev_value.get("error"):
                    pv = prev_value.get("value")
                    if isinstance(pv, (int, float)):
                        value["previous_value"] = pv
                        cur = value.get("value")
                        if isinstance(cur, (int, float)) and pv != 0:
                            value["delta_pct"] = round(((cur - pv) / pv) * 100, 1)
                        elif isinstance(cur, (int, float)) and pv == 0 and cur != 0:
                            value["delta_pct"] = None  # ∞ growth; let UI handle
            elif field_type == "line" and prev_rows is not None:
                prev_value = compute_field(f_eff, prev_rows, snaps)
                if isinstance(prev_value, dict) and "points" in prev_value:
                    # Keep the same x-axis labels as the current period so the
                    # frontend can overlay them on the same chart. The prev
                    # points carry their own (older) timestamps; the chart
                    # ignores them and just plots by index.
                    value["previous_points"] = prev_value["points"]

        out_fields.append(
            {
                "id": f.get("id", ""),
                "type": f.get("type", ""),
                "label": f.get("label", ""),
                "value": value,
            }
        )
    return {"fields": out_fields, "generated_at": datetime.now(timezone.utc)}


# ── SQL-backed path ─────────────────────────────────────────────────────────
# Same output as _compute_dashboard_data_uncached, but reads small aggregates
# from Postgres (convo_core_aggregates RPC + field_breakdown/keyword/row_count
# helpers) instead of loading every chat_row into Python. GA4 / recent-table /
# map-embed widgets reuse compute_field with their small data sources, so those
# stay byte-identical. Gated behind settings.use_sql_aggregation; verified
# field-by-field against the Python path before flipping.
_ESC_BUCKET_KEY = {"positive": "escalated_positive", "negative": "escalated_negative",
                   "neutral": "escalated_neutral", "unknown": "escalated_neutral"}


def _slices_from_breakdown(rows: list[dict]) -> dict:
    total = sum(int(r["value"]) for r in rows) or 1
    return {"slices": [{"label": r["label"], "value": int(r["value"]),
                        "pct": round(int(r["value"]) / total * 100, 1)} for r in rows]}


# Raw-field row breakdowns (role_pie / channel_bar / country_bar / language_pie).
_BREAKDOWN_KEY = {"Role": "by_role", "Channel": "by_channel",
                  "Country": "by_country_field", "Language": "by_language_field"}


def _breakdown(agg, dashboard_id, group_by, cf, ct):
    """A rollup agg carries the folded breakdown (no scan); a core agg doesn't,
    so fall back to a windowed SQL group-by. Decided per-agg (not by a global
    flag) since rolling windows are served from core even in rollup mode."""
    key = _BREAKDOWN_KEY.get(group_by, "")
    if key in agg:
        return agg.get(key) or []
    return store.field_breakdown(dashboard_id, group_by, cf, ct)


def _metric_from_agg(agg: dict, key: str, unit: str, window, **extra) -> dict:
    out = {"value": agg.get(key, 0) if agg else 0, "unit": unit, "window_days": window}
    out.update(extra)
    return out


def compute_dashboard_data_sql(
    dashboard_id: str, range_days: int | None = None, *,
    from_date: date | None = None, to_date: date | None = None,
    use_rollup: bool = False,
) -> dict:
    d = store.get_dashboard(dashboard_id)
    if not d:
        return {"fields": [], "generated_at": datetime.now(timezone.utc)}
    ga4 = store.get_ga4_for_client(d.client_id)
    all_snaps = store.snapshots_for_integration(ga4.id) if ga4 else []
    now = datetime.now(timezone.utc)
    from_dt = (datetime.combine(from_date, datetime.min.time()).replace(tzinfo=timezone.utc)
               if from_date else None)
    to_dt = (datetime.combine(to_date, datetime.max.time()).replace(tzinfo=timezone.utc)
             if to_date else None)
    has_explicit = from_dt is not None or to_dt is not None
    _micro = timedelta(microseconds=1)

    def resolve(field_window_days):
        """→ ((cur_from, cur_to), (prev_from, prev_to), effective_window_days)."""
        if field_window_days:
            return ((now - timedelta(days=field_window_days), None),
                    (now - timedelta(days=2 * field_window_days),
                     now - timedelta(days=field_window_days) - _micro), field_window_days)
        if has_explicit:
            if from_dt is not None and to_dt is not None:
                span = to_dt - from_dt
                approx = max(1, (to_date - from_date).days + 1)
                return ((from_dt, to_dt), (from_dt - span, from_dt - _micro), approx)
            return ((from_dt, to_dt), (None, None), None)
        if range_days:
            return ((now - timedelta(days=range_days), None),
                    (now - timedelta(days=2 * range_days),
                     now - timedelta(days=range_days) - _micro), range_days)
        return ((None, None), (None, None), None)

    agg_cache: dict = {}
    def get_agg(cf, ct):
        # Rollups are day-granular, so they're only EXACT for windows whose lower
        # bound sits on a midnight (the unbounded `all` view, or an explicit
        # calendar date-range). Rolling windows (7d/30d → now − N days) have a
        # mid-day lower bound; serving those from rollups would over-count the
        # partial boundary day, so route them to the timestamp-precise core path
        # (already cheap, since a bounded window scans little). This keeps both
        # paths exact and uses rollups where the cold-load cost actually lives.
        rollup_ok = use_rollup and (cf is None or cf.time() == datetime.min.time())
        key = (cf, ct, rollup_ok)
        if key not in agg_cache:
            if rollup_ok:
                agg_cache[key] = store.rollup_aggregates(
                    dashboard_id, cf.date() if cf else None, ct.date() if ct else None)
            else:
                agg_cache[key] = store.core_aggregates(dashboard_id, cf, ct)
        return agg_cache[key]

    recent_cache: dict = {}
    def get_recent(limit):
        if limit not in recent_cache:
            recent_cache[limit] = store.recent_chat_rows(dashboard_id, limit)
        return recent_cache[limit]

    out_fields = []
    for f in d.field_config:
        ftype, source = f.get("type"), f.get("source")
        (cf, ct), (pf, pt), eff = resolve(f.get("window_days"))
        agg = get_agg(cf, ct)
        f_eff = {**f, "window_days": eff} if eff else f
        value: Any

        # GA4 / map-embed / recent table → reuse compute_field with small data.
        if source in ("ga4", "ga4_traffic", "ga4_country", "ga4_revenue"):
            snaps = _ga4_within_window(all_snaps, eff, from_date_=from_date, to_date_=to_date)
            value = compute_field(f_eff, [], snaps)
        elif ftype == "table" and source == "faq_questions":
            value = {"columns": ["Question", "Conversations"], "rows": agg.get("faq", [])}
        elif ftype == "table":
            value = compute_field(f_eff, get_recent(int(f.get("limit", 20))), [])
        elif ftype == "map" and source == "phone_country":
            value = agg.get("countries", {"points": [], "total": 0})
        elif ftype == "map":
            value = compute_field(f_eff, [], [])
        elif ftype == "gauge":
            value = {"value": agg.get("sentiment_avg") or 0.0, "min": -1.0, "max": 1.0}
        elif ftype == "line":
            value = {"points": agg.get("volume_sessions_by_day", [])}
        elif ftype == "tag_cloud":
            value = {"tags": agg.get("topics", [])}
        elif ftype == "pie" and source == "ai_intent":
            value = {"slices": agg.get("intent", [])}
        elif ftype == "pie":
            value = _slices_from_breakdown(_breakdown(agg, dashboard_id, f.get("group_by", "Role"), cf, ct))
        elif ftype == "bar" and source == "language":
            value = {"bars": [{"label": b["label"], "value": b["value"]} for b in agg.get("languages", [])]}
        elif ftype == "bar":
            rows = _breakdown(agg, dashboard_id, f.get("group_by", "Channel"), cf, ct)
            value = {"bars": [{"label": r["label"], "value": int(r["value"])} for r in rows]}
        elif ftype == "metric":
            value = _metric_value(f, agg, dashboard_id, cf, ct, eff, all_snaps, from_date, to_date)
        else:
            value = compute_field(f_eff, [], [])

        # Deltas (metrics) + comparison line (line) from the previous window.
        if isinstance(value, dict) and eff and not value.get("error") and (pf or pt):
            pagg = get_agg(pf, pt)
            if ftype == "metric" and source != "ga4":
                pv = _metric_value(f, pagg, dashboard_id, pf, pt, eff, all_snaps, None, None).get("value")
                cur = value.get("value")
                if isinstance(pv, (int, float)):
                    value["previous_value"] = pv
                    if isinstance(cur, (int, float)) and pv != 0:
                        value["delta_pct"] = round(((cur - pv) / pv) * 100, 1)
                    elif isinstance(cur, (int, float)) and pv == 0 and cur != 0:
                        value["delta_pct"] = None
            elif ftype == "line":
                value["previous_points"] = pagg.get("volume_sessions_by_day", [])

        out_fields.append({"id": f.get("id", ""), "type": ftype or "",
                           "label": f.get("label", ""), "value": value})
    return {"fields": out_fields, "generated_at": datetime.now(timezone.utc)}


def _metric_value(f, agg, dashboard_id, cf, ct, eff, all_snaps, from_date, to_date) -> dict:
    """Map a metric field to its value dict from the SQL aggregates."""
    source = f.get("source")
    simple = {
        "chat_sessions": ("total_chats", "chats"),
        "user_messages": ("user_messages", "user msgs"),
        "unique_users": ("unique_users", "users"),
        "avg_messages_per_chat": ("avg_messages_per_chat", "msgs/chat"),
        "avg_response_time_seconds": ("avg_response_time", "seconds"),
        "human_escalations": ("escalations", "escalations"),
        "in_house_guests": ("in_house_guests", "in-house"),
        "booking_links_shared": ("booking_links_shared", "links shared"),
    }
    if source in simple:
        key, unit = simple[source]
        return _metric_from_agg(agg, key, unit, eff)
    if source == "escalated_by_sentiment":
        target = str(f.get("sentiment") or "").lower()
        key = _ESC_BUCKET_KEY.get(target, "escalated_neutral")
        return _metric_from_agg(agg, key, target or "escalations", eff)
    if source == "chat_count":
        return {"value": store.row_count_window(dashboard_id, cf, ct), "unit": "chats", "window_days": eff}
    if source == "keyword_count":
        kws = [str(k) for k in (f.get("keywords") or []) if str(k).strip()]
        if not kws:
            return {"value": 0, "unit": "mentions", "window_days": eff, "keywords": []}
        n = store.keyword_count(dashboard_id, kws, f.get("content_field", "Content"), cf, ct)
        return {"value": n, "unit": "mentions", "window_days": eff, "keywords": f.get("keywords")}
    if source == "ga4":
        snaps = _ga4_within_window(all_snaps, eff, from_date_=from_date, to_date_=to_date)
        return compute_field({**f, "window_days": eff} if eff else f, [], snaps)
    return {"value": 0, "unit": "", "window_days": eff}
