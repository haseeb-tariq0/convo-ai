from datetime import date, datetime, timezone

from fastapi import APIRouter, HTTPException

from ..schemas.public import PublicDashboardConfig, PublicDashboardData, PublicFieldValue
from ..services.aggregations import compute_dashboard_data
from ..store import store


def _parse_date(s: str | None) -> date | None:
    """Accept an ISO date (YYYY-MM-DD). Return None on empty / invalid so
    callers can fall back to range_days behavior."""
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None

router = APIRouter(prefix="/api/public/dashboard", tags=["public"])


def _last_updated_for(dashboard_id: str) -> datetime | None:
    rows = store.chat_rows_for_dashboard(dashboard_id)
    if not rows:
        return None
    times = [r.occurred_at for r in rows if r.occurred_at]
    return max(times) if times else None


@router.get("/{share_token}", response_model=PublicDashboardConfig)
def get_config(share_token: str) -> PublicDashboardConfig:
    d = store.get_dashboard_by_token(share_token)
    # SPEC §10: return 404 not 401 for invalid tokens to avoid leaking existence.
    if not d:
        raise HTTPException(status_code=404, detail="not found")
    return PublicDashboardConfig(
        id=d.id,
        name=d.name,
        field_config=d.field_config,
        last_updated_at=_last_updated_for(d.id),
        brand_name=d.brand_name,
        brand_logo_url=d.brand_logo_url,
        brand_primary_color=d.brand_primary_color,
        brand_accent_color=d.brand_accent_color,
        layout_config=d.layout_config,
    )


@router.get("/{share_token}/data", response_model=PublicDashboardData)
def get_data(
    share_token: str,
    since: str | None = None,
    range_days: int | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
) -> PublicDashboardData:
    """Public dashboard data.

    Three windowing modes (highest precedence wins):
      1. `from_date` + `to_date` — explicit historical range (both ISO dates).
         The aggregator filters chat_rows by `from_date <= occurred_at <= to_date`.
      2. `range_days` — chip / preset window, anchored to today. Backwards
         compatible with the original API.
      3. None — show everything, anchored to today (the dashboard's default).
    """
    d = store.get_dashboard_by_token(share_token)
    if not d:
        raise HTTPException(status_code=404, detail="not found")
    fd = _parse_date(from_date)
    td = _parse_date(to_date)
    result = compute_dashboard_data(
        d.id,
        range_days=range_days,
        from_date=fd,
        to_date=td,
    )
    # `since` is reserved for SPEC §11 incremental polling — not used yet.
    return PublicDashboardData(
        fields=[PublicFieldValue(**f) for f in result["fields"]],
        generated_at=result["generated_at"],
    )
