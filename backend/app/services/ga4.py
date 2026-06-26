"""GA4 sync.

Mock mode: produces realistic-looking daily snapshots for every metric type
SPEC §8 calls out. Real mode is a NotImplemented stub until the GA4 Data API
client is wired.

SPEC §8: ga4 syncs hourly, not 30s. Don't change that without re-reading the
SPEC's note about why."""
from __future__ import annotations

import json
import logging
import random
import time
from datetime import date, timedelta
from typing import Any

from ..config import get_settings
from ..store import GA4Snapshot, store
from . import encryption

log = logging.getLogger(__name__)


_METRIC_TYPES = ["users", "pageviews", "events", "conversions", "traffic", "devices", "country"]


def _synth_data(metric_type: str, d: date, rng: random.Random) -> dict:
    if metric_type == "users":
        return {"active_users": rng.randint(120, 480), "new_users": rng.randint(20, 120)}
    if metric_type == "pageviews":
        return {"views": rng.randint(800, 4200), "avg_session_seconds": rng.randint(45, 240)}
    if metric_type == "events":
        return {"total_events": rng.randint(1200, 6800)}
    if metric_type == "conversions":
        # Hospitality clients care about room nights + revenue.
        return {
            "conversions": rng.randint(2, 24),
            "revenue_aed": round(rng.uniform(1500, 28000), 2),
        }
    if metric_type == "traffic":
        return {
            "sources": {
                "organic": rng.randint(40, 180),
                "direct": rng.randint(20, 90),
                "social": rng.randint(10, 60),
                "referral": rng.randint(5, 40),
                "paid": rng.randint(0, 30),
            }
        }
    if metric_type == "devices":
        return {
            "mobile": rng.randint(60, 300),
            "desktop": rng.randint(30, 200),
            "tablet": rng.randint(2, 25),
        }
    if metric_type == "country":
        # Hospitality client — GCC dominant, then long tail. ISO-3166 alpha-2.
        weights = {
            "AE": 60, "SA": 35, "IN": 25, "GB": 18, "EG": 14, "KW": 12,
            "US": 10, "PK": 8, "DE": 7, "FR": 6, "RU": 5, "OM": 5,
            "QA": 4, "BH": 3, "JO": 3, "TR": 3, "CN": 2, "PH": 2,
        }
        return {
            "countries": {
                iso: max(0, int(w * rng.uniform(0.5, 1.5))) for iso, w in weights.items()
            }
        }
    return {}


def _build_client(credentials_json: str):
    """Resolve the GA4 Data API client from a service-account JSON.
    Cached per-credential so the auth handshake isn't repeated on every
    metric-type query within a sync tick. Lazy import so the mock-only
    path doesn't pay the import cost."""
    from google.analytics.data_v1beta import BetaAnalyticsDataClient
    from google.oauth2 import service_account

    info = json.loads(credentials_json)
    creds = service_account.Credentials.from_service_account_info(
        info,
        scopes=["https://www.googleapis.com/auth/analytics.readonly"],
    )
    return BetaAnalyticsDataClient(credentials=creds)


def _date_range(lookback_days: int):
    """All GA4 reports use the same `lookback_days`-back-to-today range.
    We always pull DAILY granularity so we can write one snapshot per day
    per metric_type — matches the mock pipeline + lets the aggregator
    slice by any sub-window without re-querying GA4."""
    from google.analytics.data_v1beta.types import DateRange
    end = date.today()
    start = end - timedelta(days=max(1, lookback_days))
    return DateRange(start_date=start.isoformat(), end_date=end.isoformat())


def _run_report(client, property_id: str, metrics: list[str], dimensions: list[str], date_range, *, dimension_filter=None):
    """Thin wrapper around BetaAnalyticsDataClient.run_report that
    returns the raw response. The per-metric mappers below pick which
    columns they care about."""
    from google.analytics.data_v1beta.types import (
        Dimension,
        Metric,
        RunReportRequest,
    )
    req = RunReportRequest(
        property=f"properties/{property_id}",
        date_ranges=[date_range],
        dimensions=[Dimension(name=d) for d in dimensions],
        metrics=[Metric(name=m) for m in metrics],
    )
    if dimension_filter is not None:
        req.dimension_filter = dimension_filter
    return client.run_report(req)


def _rows_by_date(response, value_fn) -> dict[str, dict[str, Any]]:
    """For reports with `date` as their first dimension: collapse into
    {date_iso: payload}. `value_fn(row)` returns the payload dict for
    one row. GA4 returns dates as 'YYYYMMDD'; we convert to ISO."""
    out: dict[str, dict[str, Any]] = {}
    for row in response.rows:
        ymd = row.dimension_values[0].value  # '20260601'
        if len(ymd) != 8:
            continue
        iso = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"
        out[iso] = value_fn(row)
    return out


def _real_fetch(integration, metric_type: str, lookback_days: int) -> list[GA4Snapshot]:
    """Live GA4 Data API query for one metric type. Returns a list of
    GA4Snapshot rows whose `data` shape MATCHES `_synth_data` above —
    that's the contract aggregations.py depends on. Don't add fields
    here without also updating the mock; the rest of the pipeline
    assumes the two paths produce identical row shapes.

    `integration.credentials_json` may be a Fernet ciphertext (new
    rows) or legacy plaintext (any row written before the encrypt-at-
    rest change landed); `decrypt_or_passthrough` handles both.
    """
    # Prefer a per-dashboard key if one was explicitly saved (a client using
    # their own account — rare); otherwise use the global Nexa service account
    # (GA4-specific env, else the shared Sheets account). Clients don't manage
    # the admin, so the global account is the norm.
    plain_creds = (
        encryption.decrypt_or_passthrough(integration.credentials_json)
        if getattr(integration, "credentials_json", None)
        else ""
    )
    if not plain_creds:
        settings = get_settings()
        plain_creds = (
            settings.google_ga4_service_account_json
            or settings.google_sheets_service_account_json
        )
    if not plain_creds:
        raise RuntimeError(
            "No GA4 service account configured. Set GOOGLE_GA4_SERVICE_ACCOUNT_JSON "
            "(or GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON) in the backend env."
        )
    client = _build_client(plain_creds)
    property_id = integration.property_id
    rng_date_range = _date_range(lookback_days)
    snaps: list[GA4Snapshot] = []

    def _snap(d_iso: str, data: dict[str, Any]) -> GA4Snapshot:
        return GA4Snapshot(
            ga4_integration_id=integration.id,
            metric_type=metric_type,
            date=d_iso,
            data=data,
        )

    if metric_type == "users":
        resp = _run_report(
            client, property_id,
            metrics=["activeUsers", "newUsers"],
            dimensions=["date"],
            date_range=rng_date_range,
        )
        by_day = _rows_by_date(resp, lambda r: {
            "active_users": int(r.metric_values[0].value or 0),
            "new_users":    int(r.metric_values[1].value or 0),
        })
        return [_snap(d, v) for d, v in by_day.items()]

    if metric_type == "pageviews":
        resp = _run_report(
            client, property_id,
            metrics=["screenPageViews", "averageSessionDuration"],
            dimensions=["date"],
            date_range=rng_date_range,
        )
        by_day = _rows_by_date(resp, lambda r: {
            "views":               int(r.metric_values[0].value or 0),
            "avg_session_seconds": int(float(r.metric_values[1].value or 0)),
        })
        return [_snap(d, v) for d, v in by_day.items()]

    if metric_type == "events":
        resp = _run_report(
            client, property_id,
            metrics=["eventCount"],
            dimensions=["date"],
            date_range=rng_date_range,
        )
        by_day = _rows_by_date(resp, lambda r: {
            "total_events": int(r.metric_values[0].value or 0),
        })
        return [_snap(d, v) for d, v in by_day.items()]

    if metric_type == "conversions":
        # Filter to the configured conversion event so we only count
        # the bookings the client cares about (e.g. `purchase`).
        from google.analytics.data_v1beta.types import (
            Filter,
            FilterExpression,
        )
        flt = FilterExpression(
            filter=Filter(
                field_name="eventName",
                string_filter=Filter.StringFilter(
                    value=integration.conversion_event_name or "purchase",
                ),
            )
        )
        resp = _run_report(
            client, property_id,
            metrics=["eventCount", "totalRevenue"],
            dimensions=["date"],
            date_range=rng_date_range,
            dimension_filter=flt,
        )
        by_day = _rows_by_date(resp, lambda r: {
            "conversions": int(r.metric_values[0].value or 0),
            # totalRevenue is reported in the property's currency. We
            # stick with the AED key for hospitality clients; if a
            # client's property is configured in USD/EUR, the field
            # label still works visually but the value is in that
            # currency. Documented quirk; a per-client `revenue_currency`
            # column can be added later if needed.
            "revenue_aed": round(float(r.metric_values[1].value or 0), 2),
        })
        return [_snap(d, v) for d, v in by_day.items()]

    if metric_type == "traffic":
        # Aggregate sessions by channel grouping, then collapse to one
        # snapshot per day with a {sources: {channel: count}} dict —
        # matching the mock's shape exactly.
        resp = _run_report(
            client, property_id,
            metrics=["sessions"],
            dimensions=["date", "sessionDefaultChannelGroup"],
            date_range=rng_date_range,
        )
        per_day_sources: dict[str, dict[str, int]] = {}
        for row in resp.rows:
            ymd = row.dimension_values[0].value
            if len(ymd) != 8:
                continue
            iso = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"
            channel = (row.dimension_values[1].value or "other").lower()
            # Map GA4's channel groups onto the mock's source keys to
            # keep aggregations.py happy. GA4 returns "Organic Search",
            # "Direct", "Paid Search", "Organic Social", "Referral",
            # etc. — normalize.
            key = (
                "organic" if "organic" in channel and "search" in channel
                else "paid"    if "paid" in channel or "cpc" in channel
                else "social"  if "social" in channel
                else "referral"if "referral" in channel
                else "direct"  if "direct" in channel
                else "other"
            )
            per_day_sources.setdefault(iso, {})
            per_day_sources[iso][key] = (
                per_day_sources[iso].get(key, 0) + int(row.metric_values[0].value or 0)
            )
        return [_snap(d, {"sources": v}) for d, v in per_day_sources.items()]

    if metric_type == "devices":
        resp = _run_report(
            client, property_id,
            metrics=["activeUsers"],
            dimensions=["date", "deviceCategory"],
            date_range=rng_date_range,
        )
        per_day: dict[str, dict[str, int]] = {}
        for row in resp.rows:
            ymd = row.dimension_values[0].value
            if len(ymd) != 8:
                continue
            iso = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"
            dev = (row.dimension_values[1].value or "desktop").lower()
            per_day.setdefault(iso, {"mobile": 0, "desktop": 0, "tablet": 0})
            if dev in ("mobile", "desktop", "tablet"):
                per_day[iso][dev] += int(row.metric_values[0].value or 0)
        return [_snap(d, v) for d, v in per_day.items()]

    if metric_type == "country":
        resp = _run_report(
            client, property_id,
            metrics=["activeUsers"],
            dimensions=["date", "countryId"],  # ISO 3166-1 alpha-2
            date_range=rng_date_range,
        )
        per_day: dict[str, dict[str, int]] = {}
        for row in resp.rows:
            ymd = row.dimension_values[0].value
            if len(ymd) != 8:
                continue
            iso = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"
            cc = (row.dimension_values[1].value or "").upper().strip()
            if not cc or cc == "(NOT SET)":
                continue
            per_day.setdefault(iso, {})
            per_day[iso][cc] = per_day[iso].get(cc, 0) + int(row.metric_values[0].value or 0)
        return [_snap(d, {"countries": v}) for d, v in per_day.items()]

    # Unknown metric_type → empty list. Surfaces as a no-op sync.
    log.warning("ga4 _real_fetch called with unknown metric_type %s", metric_type)
    return []


def sync_integration(integration) -> None:
    settings = get_settings()
    start = time.monotonic()
    enabled = {
        "users": integration.sync_users,
        "pageviews": integration.sync_pageviews,
        "events": integration.sync_events,
        "conversions": integration.sync_conversions,
        "traffic": integration.sync_traffic_sources,
        "devices": integration.sync_devices,
        # Country is a users dimension — piggyback on sync_users so we don't
        # need a schema migration just for the bubble map.
        "country": integration.sync_users,
    }
    today = date.today()
    rows_written = 0
    try:
        for metric_type, on in enabled.items():
            if not on:
                continue
            if settings.use_mock_ga4:
                rng = random.Random(f"{integration.id}:{metric_type}")
                for offset in range(integration.lookback_days):
                    d = today - timedelta(days=offset)
                    snap = GA4Snapshot(
                        ga4_integration_id=integration.id,
                        metric_type=metric_type,
                        date=d.isoformat(),
                        data=_synth_data(metric_type, d, rng),
                    )
                    store.upsert_ga4_snapshot(snap)
                    rows_written += 1
            else:
                for snap in _real_fetch(integration, metric_type, integration.lookback_days):
                    store.upsert_ga4_snapshot(snap)
                    rows_written += 1
        from datetime import datetime, timezone
        integration.last_synced_at = datetime.now(timezone.utc)
        store.log_sync(
            ga4_integration_id=integration.id,
            source="ga4",
            status="success",
            message=f"wrote {rows_written} snapshots",
            rows_processed=rows_written,
            duration_ms=int((time.monotonic() - start) * 1000),
        )
    except Exception as e:  # noqa: BLE001
        log.exception("ga4 sync failed for integration %s", integration.id)
        store.log_sync(
            ga4_integration_id=integration.id,
            source="ga4",
            status="error",
            message=f"{type(e).__name__}: {e}",
        )


def sync_all_integrations() -> None:
    for integration in store.list_ga4_integrations():
        sync_integration(integration)
