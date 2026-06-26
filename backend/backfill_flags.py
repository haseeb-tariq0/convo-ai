"""One-time backfill of the precomputed session-flag columns
(escalation_sentiment / is_in_house / has_booking_link) on chat_rows.

Reuses the exact widget logic via app.services.precompute, so the cached flags
match the live numbers by construction. Idempotent — safe to re-run; it just
recomputes and re-writes the same values.

Usage:
    python backfill_flags.py <dashboard_id>     # one dashboard
    python backfill_flags.py --all              # every dashboard

NOTE: this loads all rows for a dashboard once (the expensive op we're moving
away from) — it's a deliberate ONE-TIME batch, not a per-request cost. Going
forward the sync job computes flags incrementally as rows arrive.
"""
from __future__ import annotations

import sys
import time

from app.services.precompute import row_flag_updates
from app.store import store


def backfill_dashboard(dashboard_id: str) -> int:
    t = time.monotonic()
    rows = store.chat_rows_for_dashboard(dashboard_id)
    updates = row_flag_updates(rows)
    store.set_chat_row_flags(updates)
    print(f"  {dashboard_id}: {len(updates)} rows in {time.monotonic()-t:.1f}s")
    return len(updates)


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        return
    if sys.argv[1] == "--all":
        total = 0
        for c in store.list_clients():
            for d in store.list_dashboards_for_client(c.id):
                total += backfill_dashboard(d.id)
        print(f"done — {total} rows across all dashboards")
    else:
        backfill_dashboard(sys.argv[1])


if __name__ == "__main__":
    main()
