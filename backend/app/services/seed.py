"""Boot-time seed. Creates demo clients + dashboards so the UI has something
to render the first time you open it.

SPEC §16 hard rule: no real client data here. The two demo clients (Nest
Hotel, Rove Hotels) match the names Mohsin used in the meeting, but the
content is synthetic.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from ..store import ChatRow, GA4Snapshot

log = logging.getLogger(__name__)


_NEST_FIELD_CONFIG = [
    {
        "id": "chats_today",
        "type": "metric",
        "label": "Chats — today",
        "source": "chat_count",
        "window_days": 1,
    },
    {
        "id": "chats_week",
        "type": "metric",
        "label": "Chats — last 7 days",
        "source": "chat_count",
        "window_days": 7,
    },
    {
        "id": "chats_month",
        "type": "metric",
        "label": "Chats — last 30 days",
        "source": "chat_count",
        "window_days": 30,
    },
    {
        "id": "escalations_week",
        "type": "metric",
        "label": "Human escalations — 7d",
        "source": "human_escalations",
        "window_days": 7,
    },
    {
        "id": "sentiment_gauge",
        "type": "gauge",
        "label": "Overall sentiment",
        "source": "ai_sentiment_score",
    },
    {
        "id": "volume_chart",
        "type": "line",
        "label": "Conversations over time",
        "source": "chat_rows",
        "aggregation": "count_by_day",
        "time_field": "occurred_at",
    },
    {
        "id": "language_pie",
        "type": "pie",
        "label": "Language mix",
        "group_by": "Language",
    },
    {
        "id": "channel_bar",
        "type": "bar",
        "label": "Channels",
        "group_by": "Channel",
    },
    {
        "id": "country_bar",
        "type": "bar",
        "label": "Guests by country",
        "group_by": "Country",
    },
    {
        "id": "intent_pie",
        "type": "pie",
        "label": "Conversation intent",
        "source": "ai_intent",
    },
    {
        "id": "topics_cloud",
        "type": "tag_cloud",
        "label": "Top topics",
        "source": "ai_topics",
    },
    {
        "id": "recent_chats",
        "type": "table",
        "label": "Recent conversations",
        "limit": 25,
    },
]

# Rove additionally has GA4 wired (per the meeting: "this is Rove, they
# added in the GA4 analysis here. So we get daily revenue info"). Adds three
# widgets that source from ga4 snapshots.
_ROVE_FIELD_CONFIG = _NEST_FIELD_CONFIG + [
    {
        "id": "ga4_revenue_7d",
        "type": "metric",
        "label": "Revenue — last 7d",
        "source": "ga4",
        "metric_type": "conversions",
        "window_days": 7,
    },
    {
        "id": "ga4_users_30d",
        "type": "metric",
        "label": "Active users — 30d",
        "source": "ga4",
        "metric_type": "users",
        "window_days": 30,
    },
    {
        "id": "ga4_revenue_line",
        "type": "line",
        "label": "Daily revenue",
        "source": "ga4",
        "metric_type": "conversions",
    },
    {
        "id": "ga4_traffic_bar",
        "type": "bar",
        "label": "Traffic sources",
        "source": "ga4_traffic",
    },
]


def _seed_chat_rows(store, dashboard_id: str, count: int = 180) -> None:
    """Backfill ~180 rows spread over 14 days so the seeded dashboard has
    shape from the first page load (instead of waiting 30s for the first
    scheduler tick)."""
    # Reuses the sheets mock to keep the distribution consistent.
    from . import sheets

    rows = [sheets._synth_row_for_dashboard(dashboard_id, i) for i in range(1, count + 1)]
    store.bulk_upsert_chat_rows(rows)


def _seed_ga4_snapshots(store, integration_id: str, days: int = 30) -> None:
    import random
    from datetime import date

    from .ga4 import _synth_data

    rng = random.Random(integration_id)
    today = date.today()
    snaps: list[GA4Snapshot] = []
    for metric_type in ["users", "pageviews", "conversions", "traffic", "devices"]:
        for offset in range(days):
            d = today - timedelta(days=offset)
            snaps.append(
                GA4Snapshot(
                    ga4_integration_id=integration_id,
                    metric_type=metric_type,
                    date=d.isoformat(),
                    data=_synth_data(metric_type, d, rng),
                )
            )
    store.bulk_upsert_ga4_snapshots(snaps)


def run(store, *, frontend_url: str, admin_token: str) -> None:
    """Seed the store with demo data if it's empty. `store` is duck-typed —
    accepts either backend in store.py (in-memory or Supabase)."""
    if store.has_any_clients():
        log.info("[seed] store already populated, skipping")
        return

    nest = store.create_client(name="Nest Hotel", contact_email="ops@nesthotel.example")
    rove = store.create_client(name="Rove Hotels", contact_email="ops@rovehotels.example")

    nest_dash = store.create_dashboard(
        client_id=nest.id,
        name="Nest — Guest Conversations",
        sheet_id="MOCK_NEST_SHEET_ID",
        sheet_tab_name="Chat Logs",
        sheet_column_map={
            "timestamp": "A",
            "channel": "B",
            "user_id": "C",
            "language": "D",
            "country": "E",
            "message": "F",
        },
        field_config=_NEST_FIELD_CONFIG,
    )

    rove_dash = store.create_dashboard(
        client_id=rove.id,
        name="Rove — Conversations + Revenue",
        sheet_id="MOCK_ROVE_SHEET_ID",
        sheet_tab_name="Chat Logs",
        sheet_column_map={
            "timestamp": "A",
            "channel": "B",
            "user_id": "C",
            "language": "D",
            "country": "E",
            "message": "F",
        },
        field_config=_ROVE_FIELD_CONFIG,
    )

    # Rove gets GA4 — Nest doesn't. Matches Mohsin's "only one of the clients
    # has it" line from the meeting.
    rove_ga4 = store.upsert_ga4(
        rove.id,
        property_id="MOCK_GA4_PROPERTY_123456789",
        credentials_json="{}",  # mock; encrypted-at-rest TODO when DB lands
    )

    _seed_chat_rows(store, nest_dash.id, count=180)
    _seed_chat_rows(store, rove_dash.id, count=240)
    _seed_ga4_snapshots(store, rove_ga4.id, days=30)

    # Pre-process the seeded rows so the dashboard has AI signal on first
    # load instead of waiting 60s for the AI tick.
    from . import ai
    ai.process_pending_rows()
    # process_pending_rows caps at 50/tick; loop until clear.
    while store.unprocessed_chat_rows(limit=1):
        ai.process_pending_rows()

    log.info("[seed] Nest Hotel share link: %s/d/%s", frontend_url, nest_dash.share_token)
    log.info("[seed] Rove Hotels share link: %s/d/%s", frontend_url, rove_dash.share_token)
    log.info("[seed] Admin token: %s", admin_token)
