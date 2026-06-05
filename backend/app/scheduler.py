"""APScheduler wiring per SPEC §8.

Three jobs:
- sheets_sync — every 30s (per-dashboard `poll_interval_seconds` lives in the
  Dashboard record, but we keep one global interval for simplicity until DB
  lands; per-dashboard cadence is a small refactor away.)
- ai_processing — every 60s.
- ga4_sync — every hour. Deliberately NOT 30s; SPEC §8 calls out that the
  original brief was wrong on this and we should not regress.

Background jobs use BackgroundScheduler (not AsyncIOScheduler) because the
mock services are synchronous and the in-memory store is thread-safe. Swap to
AsyncIOScheduler once the real async clients (anthropic, httpx-based Sheets)
land."""
from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler

from .config import get_settings
from .services import ai, ga4, sheets

log = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def start_scheduler() -> BackgroundScheduler:
    global _scheduler
    if _scheduler is not None:
        return _scheduler
    settings = get_settings()
    sched = BackgroundScheduler(timezone="UTC")
    sched.add_job(sheets.sync_all_dashboards, "interval", seconds=30, id="sheets_sync", max_instances=1)
    sched.add_job(ai.process_pending_rows, "interval", seconds=60, id="ai_processing", max_instances=1)
    sched.add_job(ga4.sync_all_integrations, "interval", hours=1, id="ga4_sync", max_instances=1)
    sched.start()
    log.info(
        "scheduler started — sheets/30s, ai/60s, ga4/1h "
        "(mocks: sheets=%s ai=%s ga4=%s)",
        settings.use_mock_sheets,
        settings.use_mock_ai,
        settings.use_mock_ga4,
    )
    _scheduler = sched
    return sched


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is None:
        return
    _scheduler.shutdown(wait=False)
    _scheduler = None
    log.info("scheduler stopped")


def is_running() -> bool:
    return _scheduler is not None and _scheduler.running
