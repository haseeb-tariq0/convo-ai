"""Verify the rollup path matches the (already-verified) SQL path field-by-field.
SQL path is ground truth; rollup must match it (modulo cosmetic tie-order).

    python verify_rollup_aggregation.py [name-filter]
"""
from __future__ import annotations

import sys

from app.services.aggregations import compute_dashboard_data_sql as sql_path
from verify_sql_aggregation import _norm
from app.store import store


def diff_dashboard(dashboard_id: str, name: str, **win) -> int:
    sql = {f["id"]: f["value"] for f in sql_path(dashboard_id, use_rollup=False, **win)["fields"]}
    roll = {f["id"]: f["value"] for f in sql_path(dashboard_id, use_rollup=True, **win)["fields"]}
    diffs = 0
    label = f"{name} {win or 'all'}"
    for fid in sql:
        a, b = _norm(sql[fid]), _norm(roll.get(fid))
        if a != b:
            diffs += 1
            print(f"  DIFF [{label}] {fid}:\n    sql  = {a}\n    roll = {b}")
    if not diffs:
        print(f"  OK  {label} — {len(sql)} fields match")
    return diffs


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    total = 0
    for c in store.list_clients():
        for d in store.list_dashboards_for_client(c.id):
            if only and only.lower() not in d.name.lower():
                continue
            for win in ({}, {"range_days": 30}, {"range_days": 7}):
                total += diff_dashboard(d.id, d.name[:18], **win)
    print(f"\n{'ALL MATCH' if total == 0 else f'{total} DIFFS'}")


if __name__ == "__main__":
    main()
