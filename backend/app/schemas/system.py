"""Workspace system info — read-only snapshot of the backend's runtime
configuration. Powers the admin Settings page. Nothing here is mutable
via the API: changes require editing backend/.env + restarting.

Security: the actual API keys / secrets are NEVER returned. We only
return booleans like `openai_key_configured: bool` so the admin UI can
distinguish "key set" from "key blank" without ever exposing values.
"""
from pydantic import BaseModel


class SchedulerInfo(BaseModel):
    running: bool
    # Job cadences in seconds. Matches the values in services/scheduler.py.
    sheets_interval_seconds: int = 30
    ai_interval_seconds: int = 60
    ga4_interval_seconds: int = 3600


class AIDefaultsInfo(BaseModel):
    # Platform fallback provider + models. Per-client integrations override
    # these via the ai_integrations table.
    provider: str
    openai_model: str
    openai_key_configured: bool
    anthropic_model: str
    anthropic_key_configured: bool


class MockFlagsInfo(BaseModel):
    sheets: bool
    ai: bool
    ga4: bool


class WorkspaceCountsInfo(BaseModel):
    clients: int
    dashboards: int
    chat_rows: int
    ga4_integrations: int
    ai_integrations: int


class StorageInfo(BaseModel):
    backend: str           # "supabase" | "in-memory" | "sqlalchemy"
    supabase_url: str      # always safe to display — it's printed on the dashboard
    encryption_configured: bool


class SystemInfo(BaseModel):
    app_env: str
    log_level: str
    frontend_url: str
    cors_origins: list[str]
    storage: StorageInfo
    scheduler: SchedulerInfo
    mocks: MockFlagsInfo
    ai_defaults: AIDefaultsInfo
    counts: WorkspaceCountsInfo
