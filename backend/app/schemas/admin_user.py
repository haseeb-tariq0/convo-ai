"""Admin user-management request/response shapes.

Mirrors store.AdminUser + store.AuditLogEntry, plus enriched display
fields the Users page renders (name + avatar fetched from Supabase's
auth.users table at list time).
"""
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field


AdminRole = Literal["super_admin", "admin"]


class AdminUserIn(BaseModel):
    """POST /api/admin/users body — invite a new admin."""
    email: EmailStr
    role: AdminRole = "admin"
    notes: str | None = None


class AdminUserUpdate(BaseModel):
    """PATCH /api/admin/users/{id} body. All fields optional."""
    role: AdminRole | None = None
    is_active: bool | None = None
    notes: str | None = None


class AdminUserOut(BaseModel):
    """List + read response. Enriched with `name` and `avatar_url`
    pulled from Supabase auth.users.raw_user_meta_data when the user
    has signed in at least once."""
    id: str
    email: str
    role: AdminRole
    supabase_user_id: str | None = None
    invited_by_email: str | None = None
    invited_at: datetime
    last_signed_in_at: datetime | None = None
    is_active: bool
    notes: str | None = None
    # Enriched display fields — sourced from Supabase user metadata.
    # NULL when the invited user hasn't signed in yet.
    name: str | None = None
    avatar_url: str | None = None
    # "Currently online" flag — true when this user has a Supabase
    # session updated within the last hour.
    is_online: bool = False
    created_at: datetime
    updated_at: datetime


class AdminAuditLogOut(BaseModel):
    """GET /api/admin/audit-log row."""
    id: str
    actor_email: str
    actor_role: str | None
    action: str
    target_type: str | None
    target_id: str | None
    details: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime
