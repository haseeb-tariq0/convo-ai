"""Admin system info endpoint — read-only snapshot of how the backend
is configured at runtime. Used by the workspace Settings page so the
admin can see "is real OpenAI on?", "is Supabase wired?", "how many
clients have their own AI key?" without poking at .env.

Nothing mutable: changes to mocks / keys / models still require editing
.env + restart. The endpoint just SURFACES current state."""
from fastapi import APIRouter, Depends

from ..auth import require_admin
from ..config import get_settings
from ..scheduler import is_running
from ..schemas.system import (
    AIDefaultsInfo,
    MockFlagsInfo,
    SchedulerInfo,
    StorageInfo,
    SystemInfo,
    WorkspaceCountsInfo,
)
from ..store import store

router = APIRouter(
    prefix="/api/admin/system",
    tags=["admin/system"],
    dependencies=[Depends(require_admin)],
)


@router.get("", response_model=SystemInfo)
def get_system() -> SystemInfo:
    s = get_settings()
    backend = (
        "in-memory" if (s.use_in_memory_store or not s.supabase_configured)
        else "supabase"
    )

    # Counts — best-effort. If a particular method isn't available
    # (e.g. an older store backend hasn't implemented it), default 0.
    # Aggregating across all clients keeps the surface simple.
    clients_n = len(store.list_clients(include_inactive=True))
    dashboards_n = 0
    chat_rows_n = 0
    for c in store.list_clients(include_inactive=True):
        for d in store.list_dashboards_for_client(c.id):
            dashboards_n += 1
            chat_rows_n += len(store.chat_rows_for_dashboard(d.id))
    ga4_n = len(store.list_ga4_integrations())
    try:
        ai_n = len(store.list_ai_integrations())
    except AttributeError:
        ai_n = 0

    return SystemInfo(
        app_env=s.app_env,
        log_level=s.log_level,
        frontend_url=s.frontend_url,
        cors_origins=s.cors_origin_list,
        storage=StorageInfo(
            backend=backend,
            supabase_url=s.supabase_url,
            encryption_configured=bool(s.encryption_key),
        ),
        scheduler=SchedulerInfo(running=is_running()),
        mocks=MockFlagsInfo(
            sheets=s.use_mock_sheets,
            ai=s.use_mock_ai,
            ga4=s.use_mock_ga4,
        ),
        ai_defaults=AIDefaultsInfo(
            provider=s.ai_provider,
            openai_model=s.openai_model,
            openai_key_configured=bool(s.openai_api_key),
            anthropic_model=s.anthropic_model,
            anthropic_key_configured=bool(s.anthropic_api_key),
        ),
        counts=WorkspaceCountsInfo(
            clients=clients_n,
            dashboards=dashboards_n,
            chat_rows=chat_rows_n,
            ga4_integrations=ga4_n,
            ai_integrations=ai_n,
        ),
    )
