"""Admin allowlist + per-action audit trail.

Two tables, one file (they're always read/written together by the auth
helper and the admin router):

- `admin_users`     — who's allowed to sign into the admin panel, with
                      role + soft-delete status. Replaces the static
                      ADMIN_EMAILS env-var allowlist.
- `admin_audit_log` — what each admin did, when, against which target.
                      Append-only; never updated.

Schema lives in `backend/migrations/0010_admin_users.sql`. The env var
ADMIN_EMAILS stays a bootstrap fallback for fresh installs where the
table is empty.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, JSON, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class AdminUser(Base):
    __tablename__ = "admin_users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    # Lowercased before storage. Lookup is always case-insensitive.
    email: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    # 'super_admin' | 'admin' — plain text for forward-compat (e.g. a future
    # 'viewer' role doesn't need a DB type change).
    role: Mapped[str] = mapped_column(Text, nullable=False, default="admin")
    # Linked once the user first signs in via Google. No FK to auth.users
    # on purpose — Supabase docs discourage cross-schema FKs.
    supabase_user_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    invited_by_email: Mapped[str | None] = mapped_column(Text, nullable=True)
    invited_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False,
    )
    # NULL means "invited but never signed in" — surfaces as "pending".
    last_signed_in_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    # Soft delete. Keeps audit_log references stable.
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False,
    )


class AdminAuditLog(Base):
    __tablename__ = "admin_audit_log"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    # Snapshotted at write time (text, not FK) so soft-deleting an admin
    # doesn't lose their history. '(token)' for legacy ADMIN_TOKEN calls.
    actor_email: Mapped[str] = mapped_column(Text, nullable=False)
    actor_role: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Dot-namespaced — e.g. 'client.create', 'admin.invite', 'ga4.sync'.
    action: Mapped[str] = mapped_column(Text, nullable=False)
    target_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    details: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False,
    )
