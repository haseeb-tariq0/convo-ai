from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# `.env` lives next to the `app/` package (i.e. backend/.env), not in the
# process cwd. Without this, running `uvicorn --app-dir backend` from a
# different cwd silently misses every secret.
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(_ENV_FILE), env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"
    log_level: str = "INFO"

    admin_token: str = Field(default="dev-admin-token-change-me")
    # Comma-separated list of email addresses allowed to sign in via the
    # OAuth flow (Supabase Auth + Google). Anyone else who completes the
    # OAuth dance gets 401 on every admin endpoint. The legacy
    # `admin_token` bearer above is still accepted — useful for CLI /
    # CI / curl from scripts — but the browser admin UI uses OAuth.
    admin_emails: str = ""

    database_url: str = "postgresql://convo:convo@localhost:5432/convo_ai"

    # Supabase connection. The service-role key bypasses RLS — never hand it
    # to the frontend.
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    # Publishable / anon key — safe to expose to the frontend. Used by the
    # supabase-js client to talk to /auth/v1/* endpoints. Also used by
    # the backend's JWT verification helper to call /auth/v1/user.
    supabase_anon_key: str = ""
    # Escape hatch for offline dev + the pytest suite.
    use_in_memory_store: bool = False

    use_mock_ai: bool = True
    use_mock_sheets: bool = True
    use_mock_ga4: bool = True

    # When use_mock_ai=false, picks which real provider to call.
    # Allowed values: "openai" | "claude"  (case-insensitive).
    ai_provider: str = "openai"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-4-5-20251001"
    google_sheets_service_account_json: str = ""
    # GA4 uses the same global Nexa service account by default (clients never
    # touch the admin, so there's no reason to paste a key per dashboard). If
    # unset, falls back to the Sheets service account. A per-dashboard key is
    # only used if one is explicitly saved (rare — a client's own account).
    google_ga4_service_account_json: str = ""
    # Aggregate dashboard data in Postgres (RPC) instead of loading every
    # chat_row into Python. Fixes the memory/OOM problem at scale. See
    # docs/SCALING.md. Off by default until verified per-deployment.
    use_sql_aggregation: bool = False
    # Phase 2: read from precomputed rollup tables (sub-second cold load even on
    # huge clients). Implies the SQL path. Off until verified per-deployment.
    use_rollup_aggregation: bool = False

    # Symmetric encryption key for at-rest secrets (per-client AI keys,
    # GA4 credentials when that path lands). Base64-encoded 32-byte
    # Fernet key. Generate with:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # services/encryption.py refuses to run in production if this is empty.
    encryption_key: str = ""

    frontend_url: str = "http://localhost:5173"
    cors_origins: str = "http://localhost:5173"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def supabase_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_service_role_key)

    @property
    def admin_email_set(self) -> set[str]:
        """Parsed allowlist of admin email addresses (lowercase, trimmed)."""
        return {
            e.strip().lower()
            for e in self.admin_emails.split(",")
            if e.strip()
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()
