"""One-time build of the rollup tables (session_rollup + daily_rollup) from
existing chat_rows. Pure SQL (the flags are already on chat_rows), so it's fast.
After this, the sync keeps them current incrementally (convo_refresh_rollups).

Run AFTER the flag backfill (backfill_flags.py) — the rollups read the flag
columns.

    python backfill_rollups.py <dashboard_id>     # one dashboard
    python backfill_rollups.py --all              # every dashboard
"""
from __future__ import annotations

import sys
import time

from app.store import store


def build(dashboard_id: str) -> None:
    t = time.monotonic()
    store.build_rollups(dashboard_id)
    print(f"  {dashboard_id}: rollups built in {time.monotonic()-t:.1f}s")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        return
    if sys.argv[1] == "--all":
        for c in store.list_clients():
            for d in store.list_dashboards_for_client(c.id):
                build(d.id)
        print("done — all dashboards")
    else:
        build(sys.argv[1])


if __name__ == "__main__":
    main()
