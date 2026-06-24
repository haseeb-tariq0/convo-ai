"""Data store.

Two backends, picked from settings:

1. **Supabase** (default in prod) — uses supabase-py (PostgREST) with the
   service-role key. Schema lives in `backend/migrations/0001_initial.sql`,
   applied via the Supabase MCP `apply_migration` tool (matches the Momentum
   convention from CLAUDE.md — migrations via MCP, not Alembic).
2. **In-memory** (USE_IN_MEMORY_STORE=true) — the original dict-backed store.
   Kept for offline dev + the pytest suite, since tests shouldn't hit the
   live Supabase project.

Both backends expose identical method signatures — routers and services do
NOT know which one they're talking to. Adding/removing a backend is local
to this module.

Aggregations stay Python-side over fetched rows (see services/aggregations.py).
That works comfortably up to ~10k rows per dashboard (SPEC §17 default).
Beyond that, push aggregation into Postgres views or RPCs and read them
through this same interface.
"""
from __future__ import annotations

import secrets
import threading
import uuid
from dataclasses import asdict, dataclass, field, fields
from datetime import date, datetime, timezone
from typing import Any, Iterable

from sqlalchemy import select, update, delete, func
from sqlalchemy.orm import Session
from .database import SessionLocal
from . import models
from .config import get_settings


# ---- record types ----------------------------------------------------------
# Dataclasses are the in-process representation. The Supabase backend
# materialises rows back into these so callers always see the same shape.

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uid() -> str:
    return str(uuid.uuid4())


def _share_token() -> str:
    return secrets.token_urlsafe(24)  # SPEC §10


def _parse_dt(v: Any) -> datetime | None:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


@dataclass
class Client:
    id: str = field(default_factory=_uid)
    name: str = ""
    contact_email: str | None = None
    is_active: bool = True
    # Client-level branding defaults. Inherited by every dashboard unless
    # the dashboard sets its own brand_* override (which exists at
    # backend/app/models/dashboard.py).
    brand_name: str | None = None
    brand_logo_url: str | None = None
    brand_primary_color: str | None = None
    brand_accent_color: str | None = None
    created_at: datetime = field(default_factory=_now)
    updated_at: datetime = field(default_factory=_now)


@dataclass
class Dashboard:
    id: str = field(default_factory=_uid)
    client_id: str = ""
    name: str = ""
    share_token: str = field(default_factory=_share_token)
    sheet_id: str | None = None
    sheet_tab_name: str = "Sheet1"
    sheet_column_map: dict[str, str] = field(default_factory=dict)
    field_config: list[dict[str, Any]] = field(default_factory=list)
    poll_interval_seconds: int = 30
    is_active: bool = True
    # Per-dashboard branding (May 20 meeting). All optional — null falls
    # back to the editorial cream-and-ink Tailwind defaults.
    brand_name: str | None = None
    brand_logo_url: str | None = None
    brand_primary_color: str | None = None
    brand_accent_color: str | None = None
    # Per-dashboard layout config — section order + visibility for the public
    # magazine. Null falls back to the full default magazine layout.
    layout_config: dict[str, Any] | None = None
    created_at: datetime = field(default_factory=_now)
    updated_at: datetime = field(default_factory=_now)


@dataclass
class ChatRow:
    id: str = field(default_factory=_uid)
    dashboard_id: str = ""
    source_row_index: int = 0
    raw: dict[str, Any] = field(default_factory=dict)
    ai_sentiment: str | None = None
    ai_sentiment_score: float | None = None
    ai_topics: list[str] = field(default_factory=list)
    ai_intent: str | None = None
    ai_processed_at: datetime | None = None
    ai_retry_count: int = 0
    ai_error: str | None = None
    occurred_at: datetime | None = None


@dataclass
class GA4Integration:
    id: str = field(default_factory=_uid)
    client_id: str = ""
    property_id: str = ""
    credentials_json: str = ""
    conversion_event_name: str = "purchase"
    lookback_days: int = 30
    sync_users: bool = True
    sync_pageviews: bool = True
    sync_events: bool = False
    sync_conversions: bool = True
    sync_traffic_sources: bool = True
    sync_devices: bool = True
    last_synced_at: datetime | None = None
    created_at: datetime = field(default_factory=_now)
    updated_at: datetime = field(default_factory=_now)


@dataclass
class GA4Snapshot:
    id: str = field(default_factory=_uid)
    ga4_integration_id: str = ""
    metric_type: str = ""
    date: str = ""  # ISO date
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class AIIntegration:
    """Per-client AI provider credentials. The `api_key_encrypted` field
    holds a Fernet token via services.encryption — never the raw key.
    Callers that need the raw key call services.ai's helpers which
    decrypt on the fly + touch `last_used_at`."""
    id: str = field(default_factory=_uid)
    client_id: str = ""
    provider: str = "openai"  # "openai" | "claude"
    api_key_encrypted: str = ""
    model: str | None = None
    is_active: bool = True
    last_used_at: datetime | None = None
    created_at: datetime = field(default_factory=_now)
    updated_at: datetime = field(default_factory=_now)


@dataclass
class AdminUser:
    """Admin allowlist row. Replaces the static ADMIN_EMAILS env-var
    list — see migration 0010. Email is always stored lowercased and
    looked up case-insensitively. Soft-deleted via `is_active=False`
    rather than physical delete so the audit log keeps stable references."""
    id: str = field(default_factory=_uid)
    email: str = ""
    role: str = "admin"            # 'super_admin' | 'admin'
    supabase_user_id: str | None = None
    invited_by_email: str | None = None
    invited_at: datetime = field(default_factory=_now)
    last_signed_in_at: datetime | None = None
    is_active: bool = True
    notes: str | None = None
    created_at: datetime = field(default_factory=_now)
    updated_at: datetime = field(default_factory=_now)


@dataclass
class AuditLogEntry:
    """One row in admin_audit_log. Append-only — never updated, only
    inserted via `log_admin_action()` and read via `recent_admin_actions()`.
    `actor_email` is snapshotted at write time so a later admin-user
    soft-delete doesn't blank the history."""
    id: str = field(default_factory=_uid)
    actor_email: str = ""
    actor_role: str | None = None
    action: str = ""
    target_type: str | None = None
    target_id: str | None = None
    details: dict[str, Any] = field(default_factory=dict)
    occurred_at: datetime = field(default_factory=_now)


@dataclass
class SyncLog:
    id: str = field(default_factory=_uid)
    dashboard_id: str | None = None
    ga4_integration_id: str | None = None
    source: str = ""
    status: str = ""
    message: str = ""
    rows_processed: int | None = None
    duration_ms: int | None = None
    occurred_at: datetime = field(default_factory=_now)


# ---- serialisation helpers -------------------------------------------------

def _serialise(value: Any) -> Any:
    """Convert Python types to PostgREST-compatible JSON."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return value


def _to_row(obj: Any, *, drop: Iterable[str] = ()) -> dict[str, Any]:
    out: dict[str, Any] = {}
    drop_set = set(drop)
    for f in fields(obj):
        if f.name in drop_set:
            continue
        out[f.name] = _serialise(getattr(obj, f.name))
    return out


def _from_row(cls, row: dict[str, Any]):
    """Inflate a PostgREST row back into a dataclass. Tolerant of missing
    columns (PostgREST honours select() lists)."""
    kwargs: dict[str, Any] = {}
    for f in fields(cls):
        if f.name not in row:
            continue
        v = row[f.name]
        if f.type in ("datetime", "datetime | None"):
            v = _parse_dt(v)
        kwargs[f.name] = v
    return cls(**kwargs)


def _to_dataclass(cls, model_obj: Any):
    """Convert a SQLAlchemy model object to a dataclass."""
    if model_obj is None:
        return None
    kwargs = {}
    for f in fields(cls):
        val = getattr(model_obj, f.name, None)
        if isinstance(val, uuid.UUID):
            val = str(val)
        if isinstance(val, date) and not isinstance(val, datetime):
            val = val.isoformat()
        kwargs[f.name] = val
    return cls(**kwargs)


# ===========================================================================
# Backends
# ===========================================================================

class _InMemoryStore:
    """Original dict-backed implementation. Used when USE_IN_MEMORY_STORE=true
    or when Supabase isn't configured (so tests + offline dev still work)."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._clients: dict[str, Client] = {}
        self._dashboards: dict[str, Dashboard] = {}
        self._chat_rows: dict[str, ChatRow] = {}
        self._ga4_integrations: dict[str, GA4Integration] = {}
        self._ga4_snapshots: dict[str, GA4Snapshot] = {}
        self._ai_integrations: dict[str, AIIntegration] = {}
        self._admin_users: dict[str, AdminUser] = {}
        self._audit_log: list[AuditLogEntry] = []
        self._sync_logs: dict[str, SyncLog] = {}

    def has_any_clients(self) -> bool:
        with self._lock:
            return bool(self._clients)

    def list_ga4_integrations(self) -> list[GA4Integration]:
        with self._lock:
            return list(self._ga4_integrations.values())

    # ---- bulk paths (used by seed + AI processor) ------------------------
    def bulk_upsert_chat_rows(self, rows: list[ChatRow]) -> None:
        for r in rows:
            self.upsert_chat_row(r)

    def bulk_upsert_ga4_snapshots(self, snaps: list[GA4Snapshot]) -> None:
        for s in snaps:
            self.upsert_ga4_snapshot(s)

    def bulk_mark_chat_rows_processed(self, updates: list[dict]) -> None:
        with self._lock:
            now = _now()
            for u in updates:
                r = self._chat_rows.get(u["id"])
                if not r:
                    continue
                r.ai_sentiment = u.get("ai_sentiment")
                r.ai_sentiment_score = u.get("ai_sentiment_score")
                r.ai_topics = u.get("ai_topics", [])
                r.ai_intent = u.get("ai_intent")
                r.ai_processed_at = now
                r.ai_retry_count = u.get("ai_retry_count", r.ai_retry_count)
                r.ai_error = u.get("ai_error")

    def bulk_increment_retry_count(self, row_ids: list[str], error: str) -> None:
        with self._lock:
            for rid in row_ids:
                r = self._chat_rows.get(rid)
                if not r:
                    continue
                r.ai_retry_count += 1
                if r.ai_retry_count >= 3:
                    r.ai_error = error

    # ---- clients ---------------------------------------------------------
    def list_clients(self, include_inactive: bool = False) -> list[Client]:
        with self._lock:
            return [c for c in self._clients.values() if include_inactive or c.is_active]

    def get_client(self, client_id: str) -> Client | None:
        with self._lock:
            return self._clients.get(client_id)

    def create_client(self, *, name: str, contact_email: str | None = None) -> Client:
        with self._lock:
            c = Client(name=name, contact_email=contact_email)
            self._clients[c.id] = c
            return c

    def update_client(self, client_id: str, **patch) -> Client | None:
        with self._lock:
            c = self._clients.get(client_id)
            if not c:
                return None
            for k, v in patch.items():
                if hasattr(c, k) and v is not None:
                    setattr(c, k, v)
            c.updated_at = _now()
            return c

    def deactivate_client(self, client_id: str) -> bool:
        with self._lock:
            c = self._clients.get(client_id)
            if not c:
                return False
            c.is_active = False
            c.updated_at = _now()
            return True

    # ---- dashboards ------------------------------------------------------
    def list_dashboards_for_client(self, client_id: str) -> list[Dashboard]:
        with self._lock:
            return [d for d in self._dashboards.values() if d.client_id == client_id]

    def list_active_dashboards(self) -> list[Dashboard]:
        with self._lock:
            return [d for d in self._dashboards.values() if d.is_active]

    def get_dashboard(self, dashboard_id: str) -> Dashboard | None:
        with self._lock:
            return self._dashboards.get(dashboard_id)

    def get_dashboard_by_token(self, token: str) -> Dashboard | None:
        with self._lock:
            for d in self._dashboards.values():
                if d.share_token == token and d.is_active:
                    return d
            return None

    def create_dashboard(self, *, client_id: str, name: str, **rest) -> Dashboard:
        with self._lock:
            d = Dashboard(client_id=client_id, name=name, **rest)
            self._dashboards[d.id] = d
            return d

    def update_dashboard(self, dashboard_id: str, **patch) -> Dashboard | None:
        with self._lock:
            d = self._dashboards.get(dashboard_id)
            if not d:
                return None
            for k, v in patch.items():
                if hasattr(d, k) and v is not None:
                    setattr(d, k, v)
            d.updated_at = _now()
            return d

    def rotate_share_token(self, dashboard_id: str) -> Dashboard | None:
        with self._lock:
            d = self._dashboards.get(dashboard_id)
            if not d:
                return None
            d.share_token = _share_token()
            d.updated_at = _now()
            return d

    def delete_dashboard(self, dashboard_id: str) -> bool:
        with self._lock:
            if dashboard_id not in self._dashboards:
                return False
            del self._dashboards[dashboard_id]
            for rid in [r.id for r in self._chat_rows.values() if r.dashboard_id == dashboard_id]:
                del self._chat_rows[rid]
            return True

    # ---- chat rows -------------------------------------------------------
    def chat_rows_for_dashboard(self, dashboard_id: str) -> list[ChatRow]:
        with self._lock:
            return [r for r in self._chat_rows.values() if r.dashboard_id == dashboard_id]

    def max_chat_row_index(self, dashboard_id: str) -> int:
        with self._lock:
            idxs = [
                r.source_row_index
                for r in self._chat_rows.values()
                if r.dashboard_id == dashboard_id
            ]
            return max(idxs) if idxs else -1

    def upsert_chat_row(self, row: ChatRow) -> ChatRow:
        with self._lock:
            for existing in self._chat_rows.values():
                if (
                    existing.dashboard_id == row.dashboard_id
                    and existing.source_row_index == row.source_row_index
                ):
                    return existing
            self._chat_rows[row.id] = row
            return row

    def unprocessed_chat_rows(self, limit: int = 50) -> list[ChatRow]:
        with self._lock:
            rows = [r for r in self._chat_rows.values() if r.ai_processed_at is None]
            return rows[:limit]

    def mark_chat_row_processed(
        self, row_id: str, *, sentiment, sentiment_score, topics, intent
    ) -> None:
        with self._lock:
            r = self._chat_rows.get(row_id)
            if not r:
                return
            r.ai_sentiment = sentiment
            r.ai_sentiment_score = sentiment_score
            r.ai_topics = topics
            r.ai_intent = intent
            r.ai_processed_at = _now()

    # ---- ga4 -------------------------------------------------------------
    def get_ga4_for_client(self, client_id: str) -> GA4Integration | None:
        with self._lock:
            for g in self._ga4_integrations.values():
                if g.client_id == client_id:
                    return g
            return None

    def upsert_ga4(self, client_id: str, **patch) -> GA4Integration:
        with self._lock:
            existing = self.get_ga4_for_client(client_id)
            if existing:
                for k, v in patch.items():
                    if hasattr(existing, k) and v is not None:
                        setattr(existing, k, v)
                existing.updated_at = _now()
                return existing
            g = GA4Integration(client_id=client_id, **patch)
            self._ga4_integrations[g.id] = g
            return g

    def delete_ga4(self, client_id: str) -> bool:
        with self._lock:
            existing = self.get_ga4_for_client(client_id)
            if not existing:
                return False
            del self._ga4_integrations[existing.id]
            for sid in [s.id for s in self._ga4_snapshots.values() if s.ga4_integration_id == existing.id]:
                del self._ga4_snapshots[sid]
            return True

    def upsert_ga4_snapshot(self, snap: GA4Snapshot) -> GA4Snapshot:
        with self._lock:
            for existing in self._ga4_snapshots.values():
                if (
                    existing.ga4_integration_id == snap.ga4_integration_id
                    and existing.metric_type == snap.metric_type
                    and existing.date == snap.date
                ):
                    existing.data = snap.data
                    return existing
            self._ga4_snapshots[snap.id] = snap
            return snap

    def snapshots_for_integration(self, integration_id: str, metric_type: str | None = None) -> list[GA4Snapshot]:
        with self._lock:
            out = [s for s in self._ga4_snapshots.values() if s.ga4_integration_id == integration_id]
            if metric_type:
                out = [s for s in out if s.metric_type == metric_type]
            return sorted(out, key=lambda s: s.date)

    # ---- ai --------------------------------------------------------------
    def get_ai_for_client(self, client_id: str) -> AIIntegration | None:
        with self._lock:
            for a in self._ai_integrations.values():
                if a.client_id == client_id:
                    return a
            return None

    def upsert_ai(self, client_id: str, **patch) -> AIIntegration:
        with self._lock:
            existing = self.get_ai_for_client(client_id)
            if existing:
                for k, v in patch.items():
                    if hasattr(existing, k) and v is not None:
                        setattr(existing, k, v)
                existing.updated_at = _now()
                return existing
            a = AIIntegration(client_id=client_id, **patch)
            self._ai_integrations[a.id] = a
            return a

    def delete_ai(self, client_id: str) -> bool:
        with self._lock:
            existing = self.get_ai_for_client(client_id)
            if not existing:
                return False
            del self._ai_integrations[existing.id]
            return True

    def list_ai_integrations(self) -> list[AIIntegration]:
        with self._lock:
            return list(self._ai_integrations.values())

    def touch_ai_last_used(self, integration_id: str) -> None:
        try:
            with self._lock:
                a = self._ai_integrations.get(integration_id)
                if a is None:
                    return
                a.last_used_at = _now()
        except Exception:
            # Best-effort — never let a stat update break the AI tick.
            pass

    # ---- admin users + audit log ----------------------------------------
    def list_admin_users(self, include_inactive: bool = False) -> list[AdminUser]:
        with self._lock:
            users = list(self._admin_users.values())
            if not include_inactive:
                users = [u for u in users if u.is_active]
            return sorted(users, key=lambda u: u.invited_at, reverse=True)

    def get_admin_user(self, user_id: str) -> AdminUser | None:
        with self._lock:
            return self._admin_users.get(user_id)

    def get_admin_user_by_email(self, email: str) -> AdminUser | None:
        needle = (email or "").lower()
        with self._lock:
            for u in self._admin_users.values():
                if u.email.lower() == needle:
                    return u
            return None

    def create_admin_user(
        self,
        *,
        email: str,
        role: str,
        invited_by_email: str | None = None,
        notes: str | None = None,
    ) -> AdminUser:
        normalised = (email or "").lower()
        with self._lock:
            # Uniqueness check — caller should reactivate via update if the
            # row exists (even soft-deleted), not re-create.
            for u in self._admin_users.values():
                if u.email.lower() == normalised:
                    raise ValueError(f"admin user already exists: {normalised}")
            u = AdminUser(
                email=normalised,
                role=role,
                invited_by_email=invited_by_email,
                notes=notes,
            )
            self._admin_users[u.id] = u
            return u

    def update_admin_user(self, user_id: str, **patch) -> AdminUser | None:
        with self._lock:
            u = self._admin_users.get(user_id)
            if not u:
                return None
            for k, v in patch.items():
                if not hasattr(u, k):
                    continue
                if k == "email" and isinstance(v, str):
                    v = v.lower()
                setattr(u, k, v)
            u.updated_at = _now()
            return u

    def deactivate_admin_user(self, user_id: str) -> bool:
        with self._lock:
            u = self._admin_users.get(user_id)
            if not u or not u.is_active:
                return False
            u.is_active = False
            u.updated_at = _now()
            return True

    def touch_admin_user_signin(self, email: str, supabase_user_id: str) -> None:
        try:
            needle = (email or "").lower()
            with self._lock:
                for u in self._admin_users.values():
                    if u.email.lower() == needle:
                        u.last_signed_in_at = _now()
                        u.supabase_user_id = supabase_user_id
                        u.updated_at = _now()
                        return
        except Exception:
            # Best-effort — never let a stat update block authentication.
            pass

    def log_admin_action(
        self,
        *,
        actor_email: str,
        actor_role: str | None,
        action: str,
        target_type: str | None = None,
        target_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> AuditLogEntry:
        entry = AuditLogEntry(
            actor_email=actor_email,
            actor_role=actor_role,
            action=action,
            target_type=target_type,
            target_id=target_id,
            details=details or {},
        )
        with self._lock:
            self._audit_log.append(entry)
            return entry

    def recent_admin_actions(
        self,
        *,
        limit: int = 100,
        actor: str | None = None,
        action_prefix: str | None = None,
        since: datetime | None = None,
    ) -> list[AuditLogEntry]:
        with self._lock:
            entries = list(self._audit_log)
        if actor:
            entries = [e for e in entries if e.actor_email == actor]
        if action_prefix:
            entries = [e for e in entries if e.action.startswith(action_prefix)]
        if since:
            entries = [e for e in entries if e.occurred_at >= since]
        return sorted(entries, key=lambda e: e.occurred_at, reverse=True)[:limit]

    # ---- sync logs -------------------------------------------------------
    def log_sync(self, **fields_) -> SyncLog:
        with self._lock:
            log = SyncLog(**fields_)
            self._sync_logs[log.id] = log
            return log

    def recent_logs_for_dashboard(self, dashboard_id: str, limit: int = 50) -> list[SyncLog]:
        with self._lock:
            logs = [l for l in self._sync_logs.values() if l.dashboard_id == dashboard_id]
            return sorted(logs, key=lambda l: l.occurred_at, reverse=True)[:limit]


class _SupabaseStore:
    """PostgREST-backed implementation. All methods round-trip through
    Supabase using the service-role key (RLS is bypassed)."""

    def __init__(self, url: str, service_role_key: str) -> None:
        from supabase import Client as SupabaseClient, create_client
        # supabase-py's `Client` is thread-safe for read operations; we keep
        # writes serial to avoid the rare PostgREST race where two upserts on
        # the same `(dashboard_id, source_row_index)` could double-insert
        # before the unique index fires.
        self._lock = threading.RLock()
        self._sb: SupabaseClient = create_client(url, service_role_key)

    # ---- helpers ---------------------------------------------------------
    def _table(self, name: str):
        return self._sb.table(name)

    def has_any_clients(self) -> bool:
        # `count='exact'` with `limit(1)` is cheap — single index scan.
        res = self._table("clients").select("id", count="exact").limit(1).execute()
        return (res.count or 0) > 0

    def list_ga4_integrations(self) -> list[GA4Integration]:
        res = self._table("ga4_integrations").select("*").execute()
        return [_from_row(GA4Integration, r) for r in (res.data or [])]

    # ---- bulk paths (collapse N round-trips into ceil(N/CHUNK)) ----------
    # Seed used to do ~990 individual upserts and take ~3 minutes; bulk
    # paths take it under 10 seconds.
    _BULK_CHUNK = 500  # PostgREST default request body cap is ~1MB.

    def bulk_upsert_chat_rows(self, rows: list[ChatRow]) -> None:
        if not rows:
            return
        payload = [_to_row(r) for r in rows]
        for i in range(0, len(payload), self._BULK_CHUNK):
            self._table("chat_rows").upsert(
                payload[i : i + self._BULK_CHUNK],
                on_conflict="dashboard_id,source_row_index",
                ignore_duplicates=True,
            ).execute()

    def bulk_upsert_ga4_snapshots(self, snaps: list[GA4Snapshot]) -> None:
        if not snaps:
            return
        payload = [_to_row(s) for s in snaps]
        for i in range(0, len(payload), self._BULK_CHUNK):
            self._table("ga4_snapshots").upsert(
                payload[i : i + self._BULK_CHUNK],
                on_conflict="ga4_integration_id,metric_type,date",
            ).execute()

    def bulk_mark_chat_rows_processed(self, updates: list[dict]) -> None:
        """Bulk partial-update of chat_rows.

        Goes through the `mark_chat_rows_processed(jsonb)` Postgres function
        (defined in migration 0004) — PostgREST `upsert` with a sparse
        payload trips the dashboard_id NOT NULL constraint because the
        INSERT row is evaluated before ON CONFLICT resolution. A single
        UPDATE ... FROM jsonb_to_recordset() inside an RPC does the job
        in one round-trip for the whole batch."""
        if not updates:
            return
        for i in range(0, len(updates), self._BULK_CHUNK):
            chunk = updates[i : i + self._BULK_CHUNK]
            self._sb.rpc(
                "mark_chat_rows_processed",
                {"updates": chunk},
            ).execute()

    # ---- clients ---------------------------------------------------------
    def list_clients(self, include_inactive: bool = False) -> list[Client]:
        q = self._table("clients").select("*").order("created_at", desc=False)
        if not include_inactive:
            q = q.eq("is_active", True)
        res = q.execute()
        return [_from_row(Client, r) for r in (res.data or [])]

    def get_client(self, client_id: str) -> Client | None:
        res = self._table("clients").select("*").eq("id", client_id).limit(1).execute()
        rows = res.data or []
        return _from_row(Client, rows[0]) if rows else None

    def create_client(self, *, name: str, contact_email: str | None = None) -> Client:
        c = Client(name=name, contact_email=contact_email)
        res = self._table("clients").insert(_to_row(c)).execute()
        return _from_row(Client, (res.data or [_to_row(c)])[0])

    def update_client(self, client_id: str, **patch) -> Client | None:
        cleaned = {k: _serialise(v) for k, v in patch.items() if v is not None}
        if not cleaned:
            return self.get_client(client_id)
        res = self._table("clients").update(cleaned).eq("id", client_id).execute()
        rows = res.data or []
        return _from_row(Client, rows[0]) if rows else None

    def deactivate_client(self, client_id: str) -> bool:
        res = (
            self._table("clients")
            .update({"is_active": False})
            .eq("id", client_id)
            .execute()
        )
        return bool(res.data)

    # ---- dashboards ------------------------------------------------------
    def list_dashboards_for_client(self, client_id: str) -> list[Dashboard]:
        res = self._table("dashboards").select("*").eq("client_id", client_id).execute()
        return [_from_row(Dashboard, r) for r in (res.data or [])]

    def list_active_dashboards(self) -> list[Dashboard]:
        res = self._table("dashboards").select("*").eq("is_active", True).execute()
        return [_from_row(Dashboard, r) for r in (res.data or [])]

    def get_dashboard(self, dashboard_id: str) -> Dashboard | None:
        res = self._table("dashboards").select("*").eq("id", dashboard_id).limit(1).execute()
        rows = res.data or []
        return _from_row(Dashboard, rows[0]) if rows else None

    def get_dashboard_by_token(self, token: str) -> Dashboard | None:
        res = (
            self._table("dashboards")
            .select("*")
            .eq("share_token", token)
            .eq("is_active", True)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return _from_row(Dashboard, rows[0]) if rows else None

    def create_dashboard(self, *, client_id: str, name: str, **rest) -> Dashboard:
        d = Dashboard(client_id=client_id, name=name, **rest)
        res = self._table("dashboards").insert(_to_row(d)).execute()
        return _from_row(Dashboard, (res.data or [_to_row(d)])[0])

    def update_dashboard(self, dashboard_id: str, **patch) -> Dashboard | None:
        cleaned = {k: _serialise(v) for k, v in patch.items() if v is not None}
        if not cleaned:
            return self.get_dashboard(dashboard_id)
        res = (
            self._table("dashboards")
            .update(cleaned)
            .eq("id", dashboard_id)
            .execute()
        )
        rows = res.data or []
        return _from_row(Dashboard, rows[0]) if rows else None

    def rotate_share_token(self, dashboard_id: str) -> Dashboard | None:
        return self.update_dashboard(dashboard_id, share_token=_share_token())

    def delete_dashboard(self, dashboard_id: str) -> bool:
        # ON DELETE CASCADE in the migration takes care of chat_rows.
        res = self._table("dashboards").delete().eq("id", dashboard_id).execute()
        return bool(res.data)

    # ---- chat rows -------------------------------------------------------
    def chat_rows_for_dashboard(self, dashboard_id: str) -> list[ChatRow]:
        # Pull every row for this dashboard. Aggregations are Python-side, so
        # they need the full set. Supabase's PostgREST has a default 1000-row
        # cap — page through it explicitly.
        out: list[ChatRow] = []
        page_size = 1000
        offset = 0
        while True:
            res = (
                self._table("chat_rows")
                .select("*")
                .eq("dashboard_id", dashboard_id)
                .order("source_row_index", desc=False)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            batch = res.data or []
            out.extend(_from_row(ChatRow, r) for r in batch)
            if len(batch) < page_size:
                break
            offset += page_size
        return out

    def max_chat_row_index(self, dashboard_id: str) -> int:
        """Highest source_row_index stored for a dashboard, or -1 if none.
        Fetches a single row (not the whole table) so the sheets sync can
        resume from the tail without loading every row into memory."""
        res = (
            self._table("chat_rows")
            .select("source_row_index")
            .eq("dashboard_id", dashboard_id)
            .order("source_row_index", desc=True)
            .limit(1)
            .execute()
        )
        data = res.data or []
        return int(data[0]["source_row_index"]) if data else -1

    def upsert_chat_row(self, row: ChatRow) -> ChatRow:
        # Postgres unique (dashboard_id, source_row_index) handles dedup —
        # use on_conflict so a re-sync of the same sheet row is idempotent.
        with self._lock:
            res = (
                self._table("chat_rows")
                .upsert(
                    _to_row(row),
                    on_conflict="dashboard_id,source_row_index",
                    ignore_duplicates=True,
                )
                .execute()
            )
            rows = res.data or []
            return _from_row(ChatRow, rows[0]) if rows else row

    def unprocessed_chat_rows(self, limit: int = 50) -> list[ChatRow]:
        res = (
            self._table("chat_rows")
            .select("*")
            .is_("ai_processed_at", "null")
            .limit(limit)
            .execute()
        )
        return [_from_row(ChatRow, r) for r in (res.data or [])]

    def mark_chat_row_processed(
        self, row_id: str, *, sentiment, sentiment_score, topics, intent
    ) -> None:
        self._table("chat_rows").update(
            {
                "ai_sentiment": sentiment,
                "ai_sentiment_score": sentiment_score,
                "ai_topics": topics,
                "ai_intent": intent,
                "ai_processed_at": _serialise(_now()),
            }
        ).eq("id", row_id).execute()

    # ---- ga4 -------------------------------------------------------------
    def get_ga4_for_client(self, client_id: str) -> GA4Integration | None:
        res = (
            self._table("ga4_integrations")
            .select("*")
            .eq("client_id", client_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return _from_row(GA4Integration, rows[0]) if rows else None

    def upsert_ga4(self, client_id: str, **patch) -> GA4Integration:
        existing = self.get_ga4_for_client(client_id)
        if existing:
            cleaned = {k: _serialise(v) for k, v in patch.items() if v is not None}
            if cleaned:
                res = (
                    self._table("ga4_integrations")
                    .update(cleaned)
                    .eq("id", existing.id)
                    .execute()
                )
                rows = res.data or []
                if rows:
                    return _from_row(GA4Integration, rows[0])
            return existing
        g = GA4Integration(client_id=client_id, **patch)
        res = self._table("ga4_integrations").insert(_to_row(g)).execute()
        return _from_row(GA4Integration, (res.data or [_to_row(g)])[0])

    def delete_ga4(self, client_id: str) -> bool:
        res = self._table("ga4_integrations").delete().eq("client_id", client_id).execute()
        return bool(res.data)

    def upsert_ga4_snapshot(self, snap: GA4Snapshot) -> GA4Snapshot:
        res = (
            self._table("ga4_snapshots")
            .upsert(
                _to_row(snap),
                on_conflict="ga4_integration_id,metric_type,date",
            )
            .execute()
        )
        rows = res.data or []
        return _from_row(GA4Snapshot, rows[0]) if rows else snap

    def snapshots_for_integration(
        self, integration_id: str, metric_type: str | None = None
    ) -> list[GA4Snapshot]:
        q = (
            self._table("ga4_snapshots")
            .select("*")
            .eq("ga4_integration_id", integration_id)
            .order("date", desc=False)
        )
        if metric_type:
            q = q.eq("metric_type", metric_type)
        res = q.execute()
        return [_from_row(GA4Snapshot, r) for r in (res.data or [])]

    # ---- ai --------------------------------------------------------------
    def get_ai_for_client(self, client_id: str) -> AIIntegration | None:
        res = (
            self._table("ai_integrations")
            .select("*")
            .eq("client_id", client_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return _from_row(AIIntegration, rows[0]) if rows else None

    def upsert_ai(self, client_id: str, **patch) -> AIIntegration:
        existing = self.get_ai_for_client(client_id)
        if existing:
            cleaned = {k: _serialise(v) for k, v in patch.items() if v is not None}
            if cleaned:
                res = (
                    self._table("ai_integrations")
                    .update(cleaned)
                    .eq("id", existing.id)
                    .execute()
                )
                rows = res.data or []
                if rows:
                    return _from_row(AIIntegration, rows[0])
            return existing
        a = AIIntegration(client_id=client_id, **patch)
        res = self._table("ai_integrations").insert(_to_row(a)).execute()
        return _from_row(AIIntegration, (res.data or [_to_row(a)])[0])

    def delete_ai(self, client_id: str) -> bool:
        res = self._table("ai_integrations").delete().eq("client_id", client_id).execute()
        return bool(res.data)

    def list_ai_integrations(self) -> list[AIIntegration]:
        res = self._table("ai_integrations").select("*").execute()
        return [_from_row(AIIntegration, r) for r in (res.data or [])]

    def touch_ai_last_used(self, integration_id: str) -> None:
        try:
            self._table("ai_integrations").update(
                {"last_used_at": _now().isoformat()}
            ).eq("id", integration_id).execute()
        except Exception:
            # Best-effort — never let a stat update break the AI tick.
            pass

    # ---- admin users + audit log ----------------------------------------
    def list_admin_users(self, include_inactive: bool = False) -> list[AdminUser]:
        q = (
            self._table("admin_users")
            .select("*")
            .order("invited_at", desc=True)
        )
        if not include_inactive:
            q = q.eq("is_active", True)
        res = q.execute()
        return [_from_row(AdminUser, r) for r in (res.data or [])]

    def get_admin_user(self, user_id: str) -> AdminUser | None:
        res = self._table("admin_users").select("*").eq("id", user_id).limit(1).execute()
        rows = res.data or []
        return _from_row(AdminUser, rows[0]) if rows else None

    def get_admin_user_by_email(self, email: str) -> AdminUser | None:
        # Email is stored lowercased on write so a plain `eq` is enough;
        # we lowercase here too in case a caller passes mixed case.
        needle = (email or "").lower()
        res = (
            self._table("admin_users")
            .select("*")
            .eq("email", needle)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return _from_row(AdminUser, rows[0]) if rows else None

    def create_admin_user(
        self,
        *,
        email: str,
        role: str,
        invited_by_email: str | None = None,
        notes: str | None = None,
    ) -> AdminUser:
        normalised = (email or "").lower()
        # Caller-friendly uniqueness check — surface a clean ValueError
        # instead of letting the PostgREST 409 bubble up from the unique
        # index. We still race on it (TOCTOU) but the DB constraint wins
        # if two requests insert simultaneously.
        if self.get_admin_user_by_email(normalised) is not None:
            raise ValueError(f"admin user already exists: {normalised}")
        u = AdminUser(
            email=normalised,
            role=role,
            invited_by_email=invited_by_email,
            notes=notes,
        )
        res = self._table("admin_users").insert(_to_row(u)).execute()
        return _from_row(AdminUser, (res.data or [_to_row(u)])[0])

    def update_admin_user(self, user_id: str, **patch) -> AdminUser | None:
        cleaned: dict[str, Any] = {}
        for k, v in patch.items():
            if v is None:
                continue
            if k == "email" and isinstance(v, str):
                v = v.lower()
            cleaned[k] = _serialise(v)
        if not cleaned:
            return self.get_admin_user(user_id)
        res = (
            self._table("admin_users")
            .update(cleaned)
            .eq("id", user_id)
            .execute()
        )
        rows = res.data or []
        return _from_row(AdminUser, rows[0]) if rows else None

    def deactivate_admin_user(self, user_id: str) -> bool:
        # Soft delete only — never physical, audit_log references must
        # stay valid. The `is_active=eq.true` guard keeps the call
        # idempotent (returns False on a row that's already inactive).
        res = (
            self._table("admin_users")
            .update({"is_active": False})
            .eq("id", user_id)
            .eq("is_active", True)
            .execute()
        )
        return bool(res.data)

    def touch_admin_user_signin(self, email: str, supabase_user_id: str) -> None:
        try:
            needle = (email or "").lower()
            self._table("admin_users").update(
                {
                    "last_signed_in_at": _now().isoformat(),
                    "supabase_user_id": supabase_user_id,
                }
            ).eq("email", needle).execute()
        except Exception:
            # Best-effort — never let a stat update block authentication.
            pass

    def log_admin_action(
        self,
        *,
        actor_email: str,
        actor_role: str | None,
        action: str,
        target_type: str | None = None,
        target_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> AuditLogEntry:
        entry = AuditLogEntry(
            actor_email=actor_email,
            actor_role=actor_role,
            action=action,
            target_type=target_type,
            target_id=target_id,
            details=details or {},
        )
        self._table("admin_audit_log").insert(_to_row(entry)).execute()
        return entry

    def recent_admin_actions(
        self,
        *,
        limit: int = 100,
        actor: str | None = None,
        action_prefix: str | None = None,
        since: datetime | None = None,
    ) -> list[AuditLogEntry]:
        q = (
            self._table("admin_audit_log")
            .select("*")
            .order("occurred_at", desc=True)
            .limit(limit)
        )
        if actor:
            q = q.eq("actor_email", actor)
        if action_prefix:
            # PostgREST `like` uses `*` as the wildcard, not `%`.
            q = q.like("action", f"{action_prefix}*")
        if since:
            q = q.gte("occurred_at", _serialise(since))
        res = q.execute()
        return [_from_row(AuditLogEntry, r) for r in (res.data or [])]

    # ---- sync logs -------------------------------------------------------
    def log_sync(self, **fields_) -> SyncLog:
        log = SyncLog(**fields_)
        # The `id` and `occurred_at` defaults from our dataclass are fine —
        # we send them through so PostgREST doesn't fight us on UUID gen.
        self._table("sync_logs").insert(_to_row(log)).execute()
        return log

    def recent_logs_for_dashboard(self, dashboard_id: str, limit: int = 50) -> list[SyncLog]:
        res = (
            self._table("sync_logs")
            .select("*")
            .eq("dashboard_id", dashboard_id)
            .order("occurred_at", desc=True)
            .limit(limit)
            .execute()
        )
        return [_from_row(SyncLog, r) for r in (res.data or [])]


class _SQLAlchemyStore:
    def __init__(self, session_factory):
        self._session_factory = session_factory

    def _session(self) -> Session:
        return self._session_factory()

    def has_any_clients(self) -> bool:
        with self._session() as session:
            return session.query(models.Client).first() is not None

    def list_ga4_integrations(self) -> list[GA4Integration]:
        with self._session() as session:
            res = session.execute(select(models.GA4Integration)).scalars().all()
            return [_to_dataclass(GA4Integration, r) for r in res]

    def bulk_upsert_chat_rows(self, rows: list[ChatRow]) -> None:
        if not rows:
            return
        with self._session() as session:
            from sqlalchemy.dialects.postgresql import insert

            for r in rows:
                stmt = (
                    insert(models.ChatRow)
                    .values(
                        id=r.id,
                        dashboard_id=r.dashboard_id,
                        source_row_index=r.source_row_index,
                        raw=r.raw,
                        ai_sentiment=r.ai_sentiment,
                        ai_sentiment_score=r.ai_sentiment_score,
                        ai_topics=r.ai_topics,
                        ai_intent=r.ai_intent,
                        ai_processed_at=r.ai_processed_at,
                        ai_retry_count=r.ai_retry_count,
                        ai_error=r.ai_error,
                        occurred_at=r.occurred_at,

                    )
                    .on_conflict_do_nothing(index_elements=["dashboard_id", "source_row_index"])
                )
                session.execute(stmt)
            session.commit()

    def bulk_upsert_ga4_snapshots(self, snaps: list[GA4Snapshot]) -> None:
        if not snaps:
            return
        with self._session() as session:
            from sqlalchemy.dialects.postgresql import insert

            for s in snaps:
                d = date.fromisoformat(s.date) if isinstance(s.date, str) else s.date
                stmt = (
                    insert(models.GA4Snapshot)
                    .values(
                        id=s.id,
                        ga4_integration_id=s.ga4_integration_id,
                        metric_type=s.metric_type,
                        date=d,
                        data=s.data,
                    )
                    .on_conflict_do_update(
                        index_elements=["ga4_integration_id", "metric_type", "date"],
                        set_={"data": s.data},
                    )
                )
                session.execute(stmt)
            session.commit()

    def bulk_mark_chat_rows_processed(self, updates: list[dict]) -> None:
        if not updates:
            return
        with self._session() as session:
            now = _now()
            for u in updates:
                session.execute(
                    update(models.ChatRow)
                    .where(models.ChatRow.id == u["id"])
                    .values(
                        ai_sentiment=u.get("ai_sentiment"),
                        ai_sentiment_score=u.get("ai_sentiment_score"),
                        ai_topics=u.get("ai_topics", []),
                        ai_intent=u.get("ai_intent"),
                        ai_processed_at=now,
                    )
                )
            session.commit()

    def bulk_increment_retry_count(self, row_ids: list[str], error: str) -> None:
        if not row_ids:
            return
        with self._session() as session:
            session.execute(
                update(models.ChatRow)
                .where(models.ChatRow.id.in_(row_ids))
                .values(
                    ai_retry_count=models.ChatRow.ai_retry_count + 1,
                    ai_error=func.case(
                        (models.ChatRow.ai_retry_count + 1 >= 3, error),
                        else_=None,
                    ),
                )
            )
            session.commit()

    # ---- clients ---------------------------------------------------------
    def list_clients(self, include_inactive: bool = False) -> list[Client]:
        with self._session() as session:
            stmt = select(models.Client).order_by(models.Client.created_at)
            if not include_inactive:
                stmt = stmt.where(models.Client.is_active == True)
            res = session.execute(stmt).scalars().all()
            return [_to_dataclass(Client, r) for r in res]

    def get_client(self, client_id: str) -> Client | None:
        with self._session() as session:
            res = session.get(models.Client, client_id)
            return _to_dataclass(Client, res)

    def create_client(self, *, name: str, contact_email: str | None = None) -> Client:
        with self._session() as session:
            c = models.Client(name=name, contact_email=contact_email)
            session.add(c)
            session.commit()
            session.refresh(c)
            return _to_dataclass(Client, c)

    def update_client(self, client_id: str, **patch) -> Client | None:
        with self._session() as session:
            c = session.get(models.Client, client_id)
            if not c:
                return None
            for k, v in patch.items():
                if hasattr(c, k) and v is not None:
                    setattr(c, k, v)
            session.commit()
            session.refresh(c)
            return _to_dataclass(Client, c)

    def deactivate_client(self, client_id: str) -> bool:
        with self._session() as session:
            c = session.get(models.Client, client_id)
            if not c:
                return False
            c.is_active = False
            session.commit()
            return True

    # ---- dashboards ------------------------------------------------------
    def list_dashboards_for_client(self, client_id: str) -> list[Dashboard]:
        with self._session() as session:
            stmt = select(models.Dashboard).where(models.Dashboard.client_id == client_id)
            res = session.execute(stmt).scalars().all()
            return [_to_dataclass(Dashboard, r) for r in res]

    def list_active_dashboards(self) -> list[Dashboard]:
        with self._session() as session:
            stmt = select(models.Dashboard).where(models.Dashboard.is_active == True)
            res = session.execute(stmt).scalars().all()
            return [_to_dataclass(Dashboard, r) for r in res]

    def get_dashboard(self, dashboard_id: str) -> Dashboard | None:
        with self._session() as session:
            res = session.get(models.Dashboard, dashboard_id)
            return _to_dataclass(Dashboard, res)

    def get_dashboard_by_token(self, token: str) -> Dashboard | None:
        with self._session() as session:
            stmt = select(models.Dashboard).where(
                models.Dashboard.share_token == token, models.Dashboard.is_active == True
            )
            res = session.execute(stmt).scalar_one_or_none()
            return _to_dataclass(Dashboard, res)

    def create_dashboard(self, *, client_id: str, name: str, **rest) -> Dashboard:
        with self._session() as session:
            d = models.Dashboard(client_id=client_id, name=name, **rest)
            session.add(d)
            session.commit()
            session.refresh(d)
            return _to_dataclass(Dashboard, d)

    def update_dashboard(self, dashboard_id: str, **patch) -> Dashboard | None:
        with self._session() as session:
            d = session.get(models.Dashboard, dashboard_id)
            if not d:
                return None
            for k, v in patch.items():
                if hasattr(d, k) and v is not None:
                    setattr(d, k, v)
            session.commit()
            session.refresh(d)
            return _to_dataclass(Dashboard, d)

    def rotate_share_token(self, dashboard_id: str) -> Dashboard | None:
        return self.update_dashboard(dashboard_id, share_token=_share_token())

    def delete_dashboard(self, dashboard_id: str) -> bool:
        with self._session() as session:
            d = session.get(models.Dashboard, dashboard_id)
            if not d:
                return False
            session.delete(d)
            session.commit()
            return True

    # ---- chat rows -------------------------------------------------------
    def chat_rows_for_dashboard(self, dashboard_id: str) -> list[ChatRow]:
        with self._session() as session:
            stmt = (
                select(models.ChatRow)
                .where(models.ChatRow.dashboard_id == dashboard_id)
                .order_by(models.ChatRow.source_row_index)
            )
            res = session.execute(stmt).scalars().all()
            return [_to_dataclass(ChatRow, r) for r in res]

    def max_chat_row_index(self, dashboard_id: str) -> int:
        with self._session() as session:
            from sqlalchemy import func

            stmt = select(func.max(models.ChatRow.source_row_index)).where(
                models.ChatRow.dashboard_id == dashboard_id
            )
            val = session.execute(stmt).scalar()
            return int(val) if val is not None else -1

    def upsert_chat_row(self, row: ChatRow) -> ChatRow:
        with self._session() as session:
            from sqlalchemy.dialects.postgresql import insert

            stmt = (
                insert(models.ChatRow)
                .values(
                    id=row.id,
                    dashboard_id=row.dashboard_id,
                    source_row_index=row.source_row_index,
                    raw=row.raw,
                    occurred_at=row.occurred_at,
                )
                .on_conflict_do_nothing(index_elements=["dashboard_id", "source_row_index"])
            )
            session.execute(stmt)
            session.commit()

            # Re-fetch to get the row (whether newly inserted or existing)
            stmt = select(models.ChatRow).where(
                models.ChatRow.dashboard_id == row.dashboard_id,
                models.ChatRow.source_row_index == row.source_row_index,
            )
            res = session.execute(stmt).scalar_one()
            return _to_dataclass(ChatRow, res)

    def unprocessed_chat_rows(self, limit: int = 50) -> list[ChatRow]:
        with self._session() as session:
            stmt = (
                select(models.ChatRow)
                .where(
                    models.ChatRow.ai_processed_at == None,
                    models.ChatRow.ai_retry_count < 3,
                    models.ChatRow.ai_error == None,
                )
                .limit(limit)
            )
            res = session.execute(stmt).scalars().all()
            return [_to_dataclass(ChatRow, r) for r in res]

    def mark_chat_row_processed(
        self, row_id: str, *, sentiment, sentiment_score, topics, intent
    ) -> None:
        with self._session() as session:
            stmt = (
                update(models.ChatRow)
                .where(models.ChatRow.id == row_id)
                .values(
                    ai_sentiment=sentiment,
                    ai_sentiment_score=sentiment_score,
                    ai_topics=topics,
                    ai_intent=intent,
                    ai_processed_at=_now(),
                )
            )
            session.execute(stmt)
            session.commit()

    # ---- ga4 -------------------------------------------------------------
    def get_ga4_for_client(self, client_id: str) -> GA4Integration | None:
        with self._session() as session:
            stmt = select(models.GA4Integration).where(models.GA4Integration.client_id == client_id)
            res = session.execute(stmt).scalar_one_or_none()
            return _to_dataclass(GA4Integration, res)

    def upsert_ga4(self, client_id: str, **patch) -> GA4Integration:
        with self._session() as session:
            existing = session.execute(
                select(models.GA4Integration).where(models.GA4Integration.client_id == client_id)
            ).scalar_one_or_none()
            if existing:
                for k, v in patch.items():
                    if hasattr(existing, k) and v is not None:
                        setattr(existing, k, v)
                session.commit()
                session.refresh(existing)
                return _to_dataclass(GA4Integration, existing)

            g = models.GA4Integration(client_id=client_id, **patch)
            session.add(g)
            session.commit()
            session.refresh(g)
            return _to_dataclass(GA4Integration, g)

    def delete_ga4(self, client_id: str) -> bool:
        with self._session() as session:
            g = session.execute(
                select(models.GA4Integration).where(models.GA4Integration.client_id == client_id)
            ).scalar_one_or_none()
            if not g:
                return False
            session.delete(g)
            session.commit()
            return True

    def upsert_ga4_snapshot(self, snap: GA4Snapshot) -> GA4Snapshot:
        with self._session() as session:
            from sqlalchemy.dialects.postgresql import insert

            d = date.fromisoformat(snap.date) if isinstance(snap.date, str) else snap.date
            stmt = (
                insert(models.GA4Snapshot)
                .values(
                    id=snap.id,
                    ga4_integration_id=snap.ga4_integration_id,
                    metric_type=snap.metric_type,
                    date=d,
                    data=snap.data,
                )
                .on_conflict_do_update(
                    index_elements=["ga4_integration_id", "metric_type", "date"],
                    set_={"data": snap.data},
                )
            )
            session.execute(stmt)
            session.commit()

            stmt = select(models.GA4Snapshot).where(
                models.GA4Snapshot.ga4_integration_id == snap.ga4_integration_id,
                models.GA4Snapshot.metric_type == snap.metric_type,
                models.GA4Snapshot.date == d,
            )
            res = session.execute(stmt).scalar_one()
            return _to_dataclass(GA4Snapshot, res)

    def snapshots_for_integration(
        self, integration_id: str, metric_type: str | None = None
    ) -> list[GA4Snapshot]:
        with self._session() as session:
            stmt = (
                select(models.GA4Snapshot)
                .where(models.GA4Snapshot.ga4_integration_id == integration_id)
                .order_by(models.GA4Snapshot.date)
            )
            if metric_type:
                stmt = stmt.where(models.GA4Snapshot.metric_type == metric_type)
            res = session.execute(stmt).scalars().all()
            return [_to_dataclass(GA4Snapshot, r) for r in res]

    # ---- ai --------------------------------------------------------------
    def get_ai_for_client(self, client_id: str) -> AIIntegration | None:
        with self._session() as session:
            stmt = select(models.AIIntegration).where(models.AIIntegration.client_id == client_id)
            res = session.execute(stmt).scalar_one_or_none()
            return _to_dataclass(AIIntegration, res)

    def upsert_ai(self, client_id: str, **patch) -> AIIntegration:
        with self._session() as session:
            existing = session.execute(
                select(models.AIIntegration).where(models.AIIntegration.client_id == client_id)
            ).scalar_one_or_none()
            if existing:
                for k, v in patch.items():
                    if hasattr(existing, k) and v is not None:
                        setattr(existing, k, v)
                session.commit()
                session.refresh(existing)
                return _to_dataclass(AIIntegration, existing)

            a = models.AIIntegration(client_id=client_id, **patch)
            session.add(a)
            session.commit()
            session.refresh(a)
            return _to_dataclass(AIIntegration, a)

    def delete_ai(self, client_id: str) -> bool:
        with self._session() as session:
            a = session.execute(
                select(models.AIIntegration).where(models.AIIntegration.client_id == client_id)
            ).scalar_one_or_none()
            if not a:
                return False
            session.delete(a)
            session.commit()
            return True

    def list_ai_integrations(self) -> list[AIIntegration]:
        with self._session() as session:
            res = session.execute(select(models.AIIntegration)).scalars().all()
            return [_to_dataclass(AIIntegration, r) for r in res]

    def touch_ai_last_used(self, integration_id: str) -> None:
        try:
            with self._session() as session:
                session.execute(
                    update(models.AIIntegration)
                    .where(models.AIIntegration.id == integration_id)
                    .values(last_used_at=_now())
                )
                session.commit()
        except Exception:
            # Best-effort — never let a stat update break the AI tick.
            pass

    # ---- admin users + audit log ----------------------------------------
    def list_admin_users(self, include_inactive: bool = False) -> list[AdminUser]:
        with self._session() as session:
            stmt = select(models.AdminUser).order_by(models.AdminUser.invited_at.desc())
            if not include_inactive:
                stmt = stmt.where(models.AdminUser.is_active == True)
            res = session.execute(stmt).scalars().all()
            return [_to_dataclass(AdminUser, r) for r in res]

    def get_admin_user(self, user_id: str) -> AdminUser | None:
        with self._session() as session:
            res = session.get(models.AdminUser, user_id)
            return _to_dataclass(AdminUser, res)

    def get_admin_user_by_email(self, email: str) -> AdminUser | None:
        # Email is stored lowercased on write — case-insensitive compare
        # via func.lower in case a caller passes mixed case.
        needle = (email or "").lower()
        with self._session() as session:
            stmt = select(models.AdminUser).where(
                func.lower(models.AdminUser.email) == needle
            )
            res = session.execute(stmt).scalar_one_or_none()
            return _to_dataclass(AdminUser, res)

    def create_admin_user(
        self,
        *,
        email: str,
        role: str,
        invited_by_email: str | None = None,
        notes: str | None = None,
    ) -> AdminUser:
        normalised = (email or "").lower()
        with self._session() as session:
            # Explicit uniqueness check so the caller sees a clean
            # ValueError rather than a PostgreSQL IntegrityError on the
            # unique(email) index. The DB constraint still wins on a race.
            existing = session.execute(
                select(models.AdminUser).where(
                    func.lower(models.AdminUser.email) == normalised
                )
            ).scalar_one_or_none()
            if existing is not None:
                raise ValueError(f"admin user already exists: {normalised}")
            u = models.AdminUser(
                email=normalised,
                role=role,
                invited_by_email=invited_by_email,
                notes=notes,
            )
            session.add(u)
            session.commit()
            session.refresh(u)
            return _to_dataclass(AdminUser, u)

    def update_admin_user(self, user_id: str, **patch) -> AdminUser | None:
        with self._session() as session:
            u = session.get(models.AdminUser, user_id)
            if not u:
                return None
            for k, v in patch.items():
                if not hasattr(u, k):
                    continue
                if k == "email" and isinstance(v, str):
                    v = v.lower()
                setattr(u, k, v)
            session.commit()
            session.refresh(u)
            return _to_dataclass(AdminUser, u)

    def deactivate_admin_user(self, user_id: str) -> bool:
        with self._session() as session:
            u = session.get(models.AdminUser, user_id)
            if not u or not u.is_active:
                return False
            u.is_active = False
            session.commit()
            return True

    def touch_admin_user_signin(self, email: str, supabase_user_id: str) -> None:
        try:
            needle = (email or "").lower()
            with self._session() as session:
                session.execute(
                    update(models.AdminUser)
                    .where(func.lower(models.AdminUser.email) == needle)
                    .values(
                        last_signed_in_at=_now(),
                        supabase_user_id=supabase_user_id,
                    )
                )
                session.commit()
        except Exception:
            # Best-effort — never let a stat update block authentication.
            pass

    def log_admin_action(
        self,
        *,
        actor_email: str,
        actor_role: str | None,
        action: str,
        target_type: str | None = None,
        target_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> AuditLogEntry:
        with self._session() as session:
            row = models.AdminAuditLog(
                actor_email=actor_email,
                actor_role=actor_role,
                action=action,
                target_type=target_type,
                target_id=target_id,
                details=details or {},
            )
            session.add(row)
            session.commit()
            session.refresh(row)
            return _to_dataclass(AuditLogEntry, row)

    def recent_admin_actions(
        self,
        *,
        limit: int = 100,
        actor: str | None = None,
        action_prefix: str | None = None,
        since: datetime | None = None,
    ) -> list[AuditLogEntry]:
        with self._session() as session:
            stmt = (
                select(models.AdminAuditLog)
                .order_by(models.AdminAuditLog.occurred_at.desc())
                .limit(limit)
            )
            if actor:
                stmt = stmt.where(models.AdminAuditLog.actor_email == actor)
            if action_prefix:
                stmt = stmt.where(models.AdminAuditLog.action.like(f"{action_prefix}%"))
            if since:
                stmt = stmt.where(models.AdminAuditLog.occurred_at >= since)
            res = session.execute(stmt).scalars().all()
            return [_to_dataclass(AuditLogEntry, r) for r in res]

    # ---- sync logs -------------------------------------------------------
    def log_sync(self, **fields_) -> SyncLog:
        with self._session() as session:
            log = models.SyncLog(**fields_)
            session.add(log)
            session.commit()
            session.refresh(log)
            return _to_dataclass(SyncLog, log)

    def recent_logs_for_dashboard(self, dashboard_id: str, limit: int = 50) -> list[SyncLog]:
        with self._session() as session:
            stmt = (
                select(models.SyncLog)
                .where(models.SyncLog.dashboard_id == dashboard_id)
                .order_by(models.SyncLog.occurred_at.desc())
                .limit(limit)
            )
            res = session.execute(stmt).scalars().all()
            return [_to_dataclass(SyncLog, r) for r in res]


# ---- backend selection -----------------------------------------------------

def _build_store():
    s = get_settings()
    if s.use_in_memory_store:
        return _InMemoryStore()
    # Supabase wins when configured — it's the canonical production backend
    # per SPEC. The SQLAlchemy fallback below is for offline-dev / CI where
    # someone has stood up a local Postgres and overridden DATABASE_URL.
    # (config.py has a non-empty default for DATABASE_URL, so checking it
    # first would mask Supabase even when both are set.)
    if s.supabase_configured:
        return _SupabaseStore(s.supabase_url, s.supabase_service_role_key)
    if s.database_url:
        return _SQLAlchemyStore(SessionLocal)
    return _InMemoryStore()


# Module-level singleton — routers + services import this.
# Built lazily so test fixtures can monkeypatch settings before the first
# attribute access without paying for a Supabase connection at import time.
class _LazyStore:
    def __init__(self) -> None:
        self._impl = None

    def _resolve(self):
        if self._impl is None:
            self._impl = _build_store()
        return self._impl

    def __getattr__(self, name: str):
        return getattr(self._resolve(), name)

    def reset(self) -> None:
        """Test-only: drop the resolved backend so the next access rebuilds it.
        Use after monkeypatching settings."""
        self._impl = None


store = _LazyStore()
