from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import Settings, get_settings
from .routers import (
    admin_ai,
    admin_clients,
    admin_dashboards,
    admin_ga4,
    admin_system,
    admin_users,
    public,
)
from .scheduler import is_running, start_scheduler, stop_scheduler
from .services import seed
from .store import store


def _configure_logging(settings: Settings) -> None:
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    _configure_logging(settings)
    log = logging.getLogger("convo-ai")

    # Seed first so the scheduler's first tick finds something to sync.
    seed.run(store, frontend_url=settings.frontend_url, admin_token=settings.admin_token)
    # DISABLE_SCHEDULER lets a local dev run the API without the background
    # jobs, which is important because local runs share the PRODUCTION Supabase
    # — leaving the scheduler on writes sync logs / AI enrichment to prod.
    if os.environ.get("DISABLE_SCHEDULER", "").lower() in ("1", "true", "yes"):
        log.warning("scheduler DISABLED via DISABLE_SCHEDULER env")
    else:
        start_scheduler()

    log.info("convo-ai backend ready (env=%s)", settings.app_env)
    yield
    stop_scheduler()


app = FastAPI(title="Convo AI", version="0.1.0", lifespan=lifespan)


@app.get("/api/health")
def health(settings: Settings = Depends(get_settings)) -> dict:
    return {
        "status": "ok",
        # "supabase" when the live PostgREST client is wired; "in-memory" when
        # tests / offline dev force the fallback. Lets probes distinguish.
        "db": "in-memory" if (settings.use_in_memory_store or not settings.supabase_configured) else "supabase",
        "scheduler": "running" if is_running() else "stopped",
        "env": settings.app_env,
    }


app.include_router(admin_clients.router)
app.include_router(admin_dashboards.router)
app.include_router(admin_ga4.router)
app.include_router(admin_ai.router)
app.include_router(admin_system.router)
app.include_router(admin_users.router)
app.include_router(public.router)


# CORS — has to be added after the routers exist but before the app serves
# any request. Configured from settings so the deployed origin set lives in env.
_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
