"""Verify the SQL aggregation path matches the Python path field-by-field, for
every dashboard + a few windows. Run before flipping the SQL path on.

    python verify_sql_aggregation.py
"""
from __future__ import annotations

import sys

from app.services.aggregations import (
    _compute_dashboard_data_uncached as py_path,
    compute_dashboard_data_sql as sql_path,
    clear_aggregation_cache,
)
from app.store import store


import json

# Excluded from strict compare: the prev-period overlay is derived from a window
# anchored to now(), and the two paths run seconds apart → tiny boundary drift.
# Current values are compared strictly.
_SKIP = {"previous_value", "previous_points", "delta_pct"}


def _norm(v):
    """Round floats; drop timing-sensitive overlays; make lists of dicts
    order-independent (tie order isn't semantic for slices/bars/tags/points)."""
    if isinstance(v, float):
        return round(v, 2)
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in v.items() if k not in _SKIP}
    if isinstance(v, list):
        items = [_norm(x) for x in v]
        try:
            items = sorted(items, key=lambda x: json.dumps(x, sort_keys=True, default=str))
        except Exception:
            pass
        return items
    return v


def diff_dashboard(dashboard_id: str, name: str, **win) -> int:
    clear_aggregation_cache()
    py = {f["id"]: f["value"] for f in py_path(dashboard_id, **win)["fields"]}
    sql = {f["id"]: f["value"] for f in sql_path(dashboard_id, **win)["fields"]}
    diffs = 0
    label = f"{name} {win or 'all'}"
    for fid in py:
        a, b = _norm(py[fid]), _norm(sql.get(fid))
        if a != b:
            diffs += 1
            print(f"  DIFF [{label}] {fid}:\n     py = {a}\n    sql = {b}")
    if not diffs:
        print(f"  OK  {label} — {len(py)} fields match")
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
