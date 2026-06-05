"""One-off backfill: appends N synthetic chat rows per active dashboard
to the configured store (Supabase by default). Uses next-available
source_row_index so existing real ingested rows are never overwritten.

Run from the backend directory:
    ./.venv/Scripts/python.exe -m scripts.backfill_recent [count]

The rows use the same _synth_row_for_dashboard helper as the scheduler,
so date spread is `now() - random(0..7d)`. They flow through the AI tick
(60s cadence) just like fresh sheets-sync rows.
"""
from __future__ import annotations

import logging
import sys

from app.store import store
from app.services.sheets import _synth_row_for_dashboard

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("backfill")


def main(count_per_dash: int = 200) -> int:
    dashboards = []
    for c in store.list_clients():
        dashboards.extend(store.list_dashboards_for_client(c.id))
    if not dashboards:
        log.error("no dashboards found — is the store empty?")
        return 1
    for d in dashboards:
        if not d.is_active:
            continue
        # Append at next-available index — same scheme as the live
        # scheduler in sheets.run(), so we never collide with real data.
        existing = store.chat_rows_for_dashboard(d.id)
        next_index = max((r.source_row_index for r in existing), default=0) + 1
        rows = [
            _synth_row_for_dashboard(d.id, next_index + i)
            for i in range(count_per_dash)
        ]
        log.info(
            "[%s] appending %d rows to %s (starting at index %d)",
            d.id, count_per_dash, d.name, next_index,
        )
        store.bulk_upsert_chat_rows(rows)
    log.info("done — let the AI scheduler tick a few times to label them")
    return 0


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    sys.exit(main(n))
