"""Google Sheets sync.

Two modes:
1. Mock (USE_MOCK_SHEETS=true) — synthesises one new chat row per active
   dashboard per tick, so the public dashboard visibly grows while you watch
   it. Distributions (language, country, intent) are weighted to match what
   you'd see from a hospitality client like Nest.
2. Real — calls the Sheets API with a service-account JSON key from
   GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON. Accepts the JSON inline OR a path to
   a .json file on disk.

SPEC §8: dedup on (dashboard_id, source_row_index). The store handles that;
this module just keeps appending new indices.
"""
from __future__ import annotations

import json
import logging
import os
import random
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

from ..config import get_settings
from ..store import ChatRow, store

log = logging.getLogger(__name__)

_SHEETS_SCOPE = ["https://www.googleapis.com/auth/spreadsheets.readonly"]


# Heuristic distribution for the mock — calibrated so the seeded dashboard
# shows plausible-looking content during the demo. The schema MUST match
# what real chat-export sheets produce (Session ID, Role, Source, Content,
# User Phone, etc.) — the dashboard's aggregations key off these exact
# field names, so a different schema produces "invisible" rows that count
# as zero in every metric.
_SOURCES = ["WHATSAPP", "WHATSAPP", "WHATSAPP", "APP", "APP", "BUILDER", "VOICE"]
_LANGUAGES = ["English", "English", "English", "Arabic", "Arabic", "French"]
# E.164-style prefixes for the phone-country geo map (no Channel/Country fields
# anymore — country is derived from User Phone in services.phone_country).
_PHONE_PREFIXES = [
    ("971", "AE"), ("971", "AE"), ("971", "AE"),  # heavy UAE weight, matches a hotel
    ("966", "SA"), ("968", "OM"), ("973", "BH"), ("965", "KW"), ("974", "QA"),
    ("91", "IN"), ("44", "GB"), ("20", "EG"), ("961", "LB"),
    ("7", "RU"), ("1", "US"),
]
# User pairs: (display name, email domain). Hand-crafted so AI labels can group
# on identity without forcing every row to a new "user".
_USER_NAMES = [
    "Lubomir Marhefka", "M. Khalifa", "S. Volkov", "P. Sharma", "L. Bernard",
    "A. Al-Mansouri", "Y. Chen", "K. Müller", "R. Thompson", "F. Hussain",
    "N. Petrova", "O. Hassan",
]
_USER_MESSAGES_EN = [
    "Hi, can I book a room for tomorrow night?",
    "Is breakfast included with my reservation?",
    "Need a late checkout please, until 4pm.",
    "The wifi in room 412 is really slow, can someone help?",
    "Thanks for the great stay last weekend, loved it!",
    "Could I get an extra towel and a bottle of water?",
    "Want to order room service — what's available?",
    "I waited 30 minutes for housekeeping, this is terrible.",
    "What time does the spa open?",
    "Amazing service from the front desk, thank you!",
    "Need to extend my stay by two more nights please.",
    "Can you book a table at the restaurant for 7pm?",
    "The shower in my room is broken, urgent please.",
    "Do you have airport transfer available?",
    "Just wanted to say my room is perfect, great choice.",
    "Where is the nearest prayer room?",
    "I need to speak to a manager about my bill.",
    "Can I get a quiet room away from the elevator?",
    "Is there a gym in the hotel?",
    "Pool hours please?",
]
_USER_MESSAGES_AR = [
    "السلام عليكم، أريد حجز غرفة لليلتين",
    "هل يمكنني تأخير المغادرة من فضلكم؟",
    "شكرا لكم على الخدمة الممتازة",
    "الواي فاي في الغرفة لا يعمل بشكل جيد",
]
_ASSISTANT_REPLIES_EN = [
    "Sure, I can help with that. Could you confirm your room number?",
    "Yes, breakfast is included from 7am to 10:30am at our restaurant.",
    "I've requested a late checkout until 4pm for you — confirmed.",
    "Sorry to hear that. I've notified the team and they'll be with you shortly.",
    "Thank you so much! We'd love to see you again. 😊",
    "I'll send extra towels and water right away to your room.",
    "Our room service menu is available 24/7. Would you like the link?",
    "I apologize for the delay. The team is on the way now.",
    "The spa is open from 9am to 9pm daily.",
    "Thank you for your kind words! I'll pass them on to the front desk team.",
    "Done — your stay is extended by two nights. Your new checkout is updated.",
    "Booked for 7pm tonight at our restaurant — confirmation sent via SMS.",
    "Maintenance has been notified and will be at your door within 15 minutes.",
    "Yes, we offer airport transfers. Would you like to book one now?",
    "Wonderful to hear! Let us know if there's anything else you need.",
    "The nearest prayer room is on level 2, near the conference rooms. 🕌",
    "I've flagged this for the duty manager who will call you shortly.",
    "Absolutely — I can move you to a high floor away from the elevator.",
    "Yes, the gym is on level 3 and open 24/7 for hotel guests.",
    "The pool is open 6am–10pm daily, kids' hours are 10am–6pm.",
]


def _synth_row_for_dashboard(dashboard_id: str, source_row_index: int) -> ChatRow:
    """Synthesize one chat row matching the real chat-export schema.

    Uses `source_row_index` to bucket pairs of rows into a single Session ID
    (so we get realistic user→assistant conversation turns rather than every
    row being a new session). Even-indexed rows are User messages with a new
    random session; odd-indexed rows are the Assistant reply on that same
    session.
    """
    rng = random.Random(f"{dashboard_id}:{source_row_index}")
    # Pair (User, Assistant) per session — alternate role every row, same
    # session for two consecutive rows.
    session_seed = source_row_index // 2
    session_rng = random.Random(f"{dashboard_id}:s{session_seed}")
    session_id = f"sess-{session_rng.randint(1_000_000, 9_999_999):x}"
    is_user = source_row_index % 2 == 0
    role = "User" if is_user else "Assistant"
    language = session_rng.choice(_LANGUAGES)
    if is_user:
        pool = _USER_MESSAGES_AR if language == "Arabic" else _USER_MESSAGES_EN
    else:
        pool = _ASSISTANT_REPLIES_EN  # Assistant replies in English for simplicity
    content = rng.choice(pool)
    source = session_rng.choice(_SOURCES)
    name = session_rng.choice(_USER_NAMES)
    email = f"{name.split()[0].lower()}.{name.split()[-1].lower()}@example.com"
    prefix, _iso = session_rng.choice(_PHONE_PREFIXES)
    phone = f"+{prefix}{session_rng.randint(100_000_000, 999_999_999)}"
    # Spread across the last 7 days (tighter than before so the freshly-
    # synth'd rows actually populate the 7d window the dashboard defaults to).
    offset_minutes = rng.randint(0, 7 * 24 * 60)
    # Anchor User/Assistant pairs ~30 seconds apart so the avg-response-time
    # metric gets meaningful deltas; the pair shares a session_seed so the
    # offset is stable.
    base_offset = random.Random(f"{dashboard_id}:t{session_seed}").randint(0, 7 * 24 * 60)
    response_delay = rng.randint(8, 45) if not is_user else 0
    occurred_at = (
        datetime.now(timezone.utc)
        - timedelta(minutes=base_offset)
        + timedelta(seconds=response_delay)
    )
    # Silence unused-variable lint: `offset_minutes` is kept as a fall-back
    # entropy source for non-pairwise scenarios.
    _ = offset_minutes
    return ChatRow(
        dashboard_id=dashboard_id,
        source_row_index=source_row_index,
        raw={
            "Timestamp": occurred_at.isoformat(),
            "Source": source,
            "Session ID": session_id,
            "Role": role,
            "Content": content,
            "User Name": name,
            "User Email": email,
            "User Phone": phone,
        },
        occurred_at=occurred_at,
    )


@lru_cache(maxsize=1)
def _sheets_service():
    """Lazy-built, cached Sheets API client. Imports are inside the function
    so the mock path doesn't require google-* to be installed."""
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build

    raw = get_settings().google_sheets_service_account_json.strip()
    if not raw:
        raise RuntimeError(
            "GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is empty. Paste the full JSON "
            "(one line) or a path to the .json file into backend/.env."
        )
    info: dict
    # Accept either inline JSON or a filesystem path. Path detection is
    # cheap: if the env value parses as JSON, it's inline; otherwise treat
    # as a path.
    try:
        info = json.loads(raw)
    except json.JSONDecodeError:
        p = Path(raw)
        if not p.is_file():
            raise RuntimeError(
                f"GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is not valid JSON and "
                f"not a readable file path: {raw!r}"
            )
        info = json.loads(p.read_text(encoding="utf-8"))
    creds = Credentials.from_service_account_info(info, scopes=_SHEETS_SCOPE)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def _col_letter_to_index(letter: str) -> int:
    """A → 0, B → 1, ... Z → 25, AA → 26."""
    n = 0
    for c in letter.strip().upper():
        if not ("A" <= c <= "Z"):
            raise ValueError(f"invalid column letter: {letter!r}")
        n = n * 26 + (ord(c) - ord("A") + 1)
    return n - 1


def _real_fetch(dashboard, start_index: int = 0) -> tuple[list[str], list[dict]]:
    """Pull rows from the dashboard's Sheet, starting at DATA row
    ``start_index`` (0-based, *after* the header). ``start_index=0`` reads
    the whole sheet; a higher value reads only the new tail — this is what
    makes the sync incremental, so we don't re-load all ~9k rows every tick.

    Returns ``(headers, rows)`` where rows are dicts keyed by header names
    per SPEC §6. The headers (row 1) are fetched separately and cheaply so
    callers can still resolve the column map's semantic names
    ("timestamp" → "A" → headers[0])."""
    from googleapiclient.errors import HttpError

    if not dashboard.sheet_id:
        return [], []
    service = _sheets_service()
    tab = dashboard.sheet_tab_name or "Sheet1"
    # Quote the tab name — handles spaces ("Chat Logs") and apostrophes.
    safe_tab = "'" + tab.replace("'", "''") + "'"
    # Data index i lives at sheet row i+2 (row 1 is the header), so the tail
    # starting at `start_index` begins at sheet row start_index+2.
    first_data_row = max(0, start_index) + 2
    try:
        # Header row (tiny — one row) and the data tail in two reads.
        head_res = (
            service.spreadsheets()
            .values()
            .get(spreadsheetId=dashboard.sheet_id, range=f"{safe_tab}!1:1")
            .execute()
        )
        head_vals = head_res.get("values", [])
        if not head_vals:
            return [], []
        headers = [h.strip() for h in head_vals[0]]

        data_res = (
            service.spreadsheets()
            .values()
            .get(spreadsheetId=dashboard.sheet_id, range=f"{safe_tab}!A{first_data_row}:ZZ")
            .execute()
        )
    except HttpError as e:
        # Surface the API status so the sync_log entry is debuggable
        # (403 = sheet not shared with the service account; 404 = bad
        # sheet_id; 400 = bad range/tab name).
        raise RuntimeError(f"Sheets API {e.resp.status}: {e._get_reason()}") from e

    values: list[list[str]] = data_res.get("values", [])
    rows: list[dict] = []
    for raw_row in values:
        # Pad short rows so every dict has every header key — cells past the
        # last non-empty one come back missing from the API.
        padded = list(raw_row) + [""] * (len(headers) - len(raw_row))
        rows.append({h: padded[i] for i, h in enumerate(headers) if h})
    return headers, rows


def _timestamp_header(column_map: dict[str, str], headers: list[str]) -> str | None:
    """Resolve which header name carries the timestamp, via the
    semantic column map. Returns None if no mapping or out of range."""
    letter = (column_map or {}).get("timestamp")
    if not letter:
        return None
    try:
        idx = _col_letter_to_index(letter)
    except ValueError:
        return None
    if 0 <= idx < len(headers):
        return headers[idx]
    return None


def _refresh_session_flags(dashboard_id: str, batch: list) -> None:
    """Keep the precomputed session-flag columns current: for every session
    touched by the new rows, reload the whole session and recompute its flags
    (a flag is a property of the whole conversation, so a new message can change
    it). Best-effort — a failure here must never break the sync."""
    if not getattr(store, "chat_rows_for_sessions", None):
        return  # store backend without flag support (e.g. in-memory tests)
    try:
        from .precompute import row_flag_updates

        sids = {r.raw.get("Session ID") for r in batch if r.raw.get("Session ID")}
        if not sids:
            return
        rows = store.chat_rows_for_sessions(dashboard_id, list(sids))
        store.set_chat_row_flags(row_flag_updates(rows))
    except Exception:  # noqa: BLE001
        log.exception("session-flag refresh failed for dashboard %s", dashboard_id)


def _refresh_rollups(dashboard_id: str, batch: list) -> None:
    """After the flags are refreshed, rebuild the rollup tables for the touched
    sessions + days so the fast (rollup) read path stays current. Must run AFTER
    _refresh_session_flags (rollups read the flag columns). Best-effort."""
    if not getattr(store, "refresh_rollups", None):
        return  # store backend without rollup support (e.g. in-memory tests)
    try:
        sids = {r.raw.get("Session ID") for r in batch if r.raw.get("Session ID")}
        days = {r.occurred_at.date().isoformat() for r in batch if r.occurred_at}
        store.refresh_rollups(dashboard_id, list(sids), list(days))
    except Exception:  # noqa: BLE001
        log.exception("rollup refresh failed for dashboard %s", dashboard_id)


def sync_all_dashboards() -> None:
    """Scheduler tick. Adds one mock row per dashboard when in mock mode;
    otherwise pulls only the NEW rows from each Sheet (incremental — resumes
    from the highest source_row_index already stored) so we never re-load the
    whole sheet into memory every tick."""
    settings = get_settings()
    start = time.monotonic()
    total_new = 0
    for d in store.list_active_dashboards():
        if not d.sheet_id:
            continue
        try:
            if settings.use_mock_sheets:
                # Mock mode: append one new row per tick so the dashboard
                # demonstrably grows during a live demo.
                next_index = store.max_chat_row_index(d.id) + 1
                row = _synth_row_for_dashboard(d.id, next_index)
                store.upsert_chat_row(row)
                total_new += 1
            else:
                # Resume from the row after the last one we stored — fetch and
                # upsert only the tail, not all ~9k rows. Idempotent on
                # (dashboard_id, source_row_index), so a re-run is harmless.
                start_index = store.max_chat_row_index(d.id) + 1
                headers, rows = _real_fetch(d, start_index)
                if rows:
                    ts_header = _timestamp_header(d.sheet_column_map, headers)
                    # Bulk path — store.bulk_upsert_chat_rows chunks the
                    # Supabase calls. Single-row upserts at ~150ms each are too
                    # slow for the first full sync of a large sheet.
                    batch = [
                        ChatRow(
                            dashboard_id=d.id,
                            source_row_index=start_index + i,
                            raw=raw,
                            occurred_at=_parse_timestamp(raw, ts_header),
                        )
                        for i, raw in enumerate(rows)
                    ]
                    store.bulk_upsert_chat_rows(batch)
                    total_new += len(batch)
                    _refresh_session_flags(d.id, batch)
                    _refresh_rollups(d.id, batch)
            store.log_sync(
                dashboard_id=d.id,
                source="sheets",
                status="success",
                message=f"+{total_new} new rows",
                rows_processed=total_new,
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except Exception as e:  # noqa: BLE001
            log.exception("sheets sync failed for dashboard %s", d.id)
            store.log_sync(
                dashboard_id=d.id,
                source="sheets",
                status="error",
                message=f"{type(e).__name__}: {e}",
            )


def _parse_timestamp(raw: dict, ts_header: str | None = None) -> datetime | None:
    """Pull and parse the timestamp from a row.

    Preference order: explicit header from the dashboard's column map →
    common fallback names ("Timestamp", "timestamp"). Returns None if the
    cell is empty or unparseable — the row still lands, it just won't
    show up on time-series widgets.
    """
    ts = None
    if ts_header and ts_header in raw:
        ts = raw[ts_header]
    if not ts:
        ts = raw.get("Timestamp") or raw.get("timestamp")
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except (ValueError, AttributeError, TypeError):
        return None


def manual_sync(dashboard_id: str) -> int:
    """Triggered by `POST /api/admin/dashboards/{id}/sync`. Returns count of
    rows newly added. Bypasses the scheduler — useful when Mohsin clicks the
    'sync now' button in the admin UI."""
    d = store.get_dashboard(dashboard_id)
    if not d:
        return 0
    settings = get_settings()
    if not settings.use_mock_sheets:
        headers, rows = _real_fetch(d)
        ts_header = _timestamp_header(d.sheet_column_map, headers)
        existing_indices = {r.source_row_index for r in store.chat_rows_for_dashboard(d.id)}
        batch = [
            ChatRow(
                dashboard_id=d.id,
                source_row_index=i,
                raw=raw,
                occurred_at=_parse_timestamp(raw, ts_header),
            )
            for i, raw in enumerate(rows)
        ]
        store.bulk_upsert_chat_rows(batch)
        return sum(1 for i, _ in enumerate(rows) if i not in existing_indices)
    # Mock: add a handful so the user sees something happen on click.
    existing = store.chat_rows_for_dashboard(dashboard_id)
    next_index = max((r.source_row_index for r in existing), default=0) + 1
    for i in range(5):
        store.upsert_chat_row(_synth_row_for_dashboard(dashboard_id, next_index + i))
    return 5
