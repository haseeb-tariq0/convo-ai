"""Admin user-management endpoints.

GET    /api/admin/users           list — admin role required
POST   /api/admin/users           invite — super_admin only
PATCH  /api/admin/users/{id}      change role / is_active / notes — super_admin only
DELETE /api/admin/users/{id}      soft-delete + remove from Supabase — super_admin only
POST   /api/admin/users/{id}/signout
                                  force-signout from Supabase — super_admin only
GET    /api/admin/audit-log       recent action log — admin role required

The Users page on the frontend is the primary consumer. The list
endpoint enriches each row with `name` + `avatar_url` from Supabase
user metadata + an `is_online` flag computed from active sessions —
this is one round-trip to Supabase per page-load (cached in supabase_admin),
not one per row.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ..auth import AdminPrincipal, current_admin, require_admin, require_super_admin
from ..schemas.admin_user import (
    AdminAuditLogOut,
    AdminUserIn,
    AdminUserOut,
    AdminUserUpdate,
)
from ..services import audit, supabase_admin
from ..store import AdminUser, AuditLogEntry, store

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/admin",
    tags=["admin/users"],
)


def _serialize(
    u: AdminUser,
    *,
    online_ids: set[str],
    enrich: dict[str, dict[str, Any]] | None = None,
) -> AdminUserOut:
    """Materialise a store.AdminUser into the wire shape, mixing in
    Supabase enrichment when available."""
    meta: dict[str, Any] = {}
    if enrich and u.supabase_user_id and u.supabase_user_id in enrich:
        meta = enrich[u.supabase_user_id].get("user_metadata", {}) or {}
    return AdminUserOut(
        id=u.id,
        email=u.email,
        role=u.role,  # type: ignore[arg-type]  Literal narrows
        supabase_user_id=u.supabase_user_id,
        invited_by_email=u.invited_by_email,
        invited_at=u.invited_at,
        last_signed_in_at=u.last_signed_in_at,
        is_active=u.is_active,
        notes=u.notes,
        name=meta.get("full_name") or meta.get("name"),
        avatar_url=meta.get("avatar_url"),
        is_online=bool(u.supabase_user_id and u.supabase_user_id in online_ids),
        created_at=u.created_at,
        updated_at=u.updated_at,
    )


@router.get("/me")
def me(principal: AdminPrincipal = Depends(current_admin)) -> dict[str, Any]:
    """Return the verified-principal view of the current caller. The
    Users page + sidebar pill use this as the source of truth for
    "am I a super_admin?" — more reliable than reading the Supabase
    session synchronously on the client, which can be null on first
    render before the SDK populates it.

    For legacy bearer-token callers (no identity), returns
    `{kind: 'token', role: 'super_admin'}` so the UI treats them as
    fully privileged (the token bypasses everything anyway).
    """
    out: dict[str, Any] = {
        "kind": principal.get("kind"),
        "email": principal.get("email"),
        "role": principal.get("role"),
        "user_id": principal.get("user_id"),
    }
    if out["kind"] == "token":
        # Legacy token has no identity, but it has FULL permissions —
        # surface it as super_admin to the UI so the menu items show.
        out["role"] = "super_admin"
        out["email"] = "(admin token)"
    return out


@router.get(
    "/users",
    response_model=list[AdminUserOut],
    dependencies=[Depends(require_admin)],
)
def list_admins(include_inactive: bool = False) -> list[AdminUserOut]:
    users = store.list_admin_users(include_inactive=include_inactive)
    # One Supabase round-trip to enrich names + avatars + online flags.
    online_ids = supabase_admin.active_session_user_ids(within_seconds=3600)
    enrich: dict[str, dict[str, Any]] = {}
    for u in users:
        if u.supabase_user_id:
            su = supabase_admin.get_user(u.supabase_user_id)
            if su:
                enrich[u.supabase_user_id] = su
    return [_serialize(u, online_ids=online_ids, enrich=enrich) for u in users]


@router.post(
    "/users",
    response_model=AdminUserOut,
    status_code=status.HTTP_201_CREATED,
)
def invite_admin(
    payload: AdminUserIn,
    principal: AdminPrincipal = Depends(require_super_admin),
) -> AdminUserOut:
    """Create an admin_users row AND send a Supabase magic-link invite
    email. The user clicks the email → lands in Google OAuth → returns
    to /admin signed in. Their first verified auth links
    `supabase_user_id` on the row.

    If the email already exists (active or soft-deleted), 409. Use
    PATCH to reactivate instead.
    """
    email = payload.email.strip().lower()
    existing = store.get_admin_user_by_email(email)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{email} already exists "
                f"(is_active={existing.is_active}, role={existing.role}). "
                "Use PATCH to reactivate or change role."
            ),
        )

    # Trigger the Supabase magic-link email FIRST. If Supabase is
    # misconfigured (SMTP not set up, rate-limited, etc.) we don't
    # want to leave a phantom admin_users row that can't sign in.
    sent = supabase_admin.invite_user(email)
    if not sent:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                "Could not send invite email via Supabase. "
                "Check that SMTP is configured in Authentication → Emails."
            ),
        )

    row = store.create_admin_user(
        email=email,
        role=payload.role,
        invited_by_email=principal.get("email"),
        notes=payload.notes,
    )
    audit.log_action(
        principal,
        "admin.invite",
        target_type="admin_user",
        target_id=row.id,
        email=email,
        role=payload.role,
    )

    online_ids = supabase_admin.active_session_user_ids(within_seconds=3600)
    return _serialize(row, online_ids=online_ids)


@router.patch("/users/{user_id}", response_model=AdminUserOut)
def update_admin(
    user_id: str,
    payload: AdminUserUpdate,
    principal: AdminPrincipal = Depends(require_super_admin),
) -> AdminUserOut:
    target = store.get_admin_user(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="admin user not found")

    # Guard: never let the last super_admin demote themselves OR be
    # demoted/deactivated. There must always be at least one active
    # super_admin who can manage the rest.
    patch = payload.model_dump(exclude_unset=True)
    will_lose_super = (
        target.role == "super_admin"
        and (
            ("role" in patch and patch["role"] != "super_admin")
            or ("is_active" in patch and patch["is_active"] is False)
        )
    )
    if will_lose_super:
        actives = [u for u in store.list_admin_users() if u.role == "super_admin"]
        if len(actives) <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="cannot remove the last super_admin",
            )

    updated = store.update_admin_user(user_id, **patch)
    assert updated is not None  # get_admin_user just succeeded
    audit.log_action(
        principal,
        "admin.update",
        target_type="admin_user",
        target_id=updated.id,
        email=updated.email,
        changed=list(patch.keys()),
    )

    online_ids = supabase_admin.active_session_user_ids(within_seconds=3600)
    enrich = {}
    if updated.supabase_user_id:
        su = supabase_admin.get_user(updated.supabase_user_id)
        if su:
            enrich[updated.supabase_user_id] = su
    return _serialize(updated, online_ids=online_ids, enrich=enrich)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_admin(
    user_id: str,
    principal: AdminPrincipal = Depends(require_super_admin),
) -> None:
    """Soft-delete (is_active=false) + DELETE the linked Supabase user.
    Same last-super_admin guard as PATCH."""
    target = store.get_admin_user(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="admin user not found")
    if target.role == "super_admin":
        actives = [u for u in store.list_admin_users() if u.role == "super_admin"]
        if len(actives) <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="cannot remove the last super_admin",
            )

    # Soft-delete first so even if Supabase is unreachable, the
    # allowlist is immediately tightened.
    store.deactivate_admin_user(user_id)
    if target.supabase_user_id:
        supabase_admin.delete_user(target.supabase_user_id)

    audit.log_action(
        principal,
        "admin.remove",
        target_type="admin_user",
        target_id=user_id,
        email=target.email,
        role=target.role,
    )


@router.post("/users/{user_id}/signout")
def force_signout(
    user_id: str,
    principal: AdminPrincipal = Depends(require_super_admin),
) -> dict[str, bool]:
    """Force-sign-out a user from all Supabase sessions. Their next
    refresh fails immediately; access token expires within ~1 hour."""
    target = store.get_admin_user(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="admin user not found")
    if not target.supabase_user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="user has never signed in via Google — no Supabase session to revoke",
        )
    ok = supabase_admin.sign_out_user(target.supabase_user_id)
    audit.log_action(
        principal,
        "admin.signout",
        target_type="admin_user",
        target_id=user_id,
        email=target.email,
        success=ok,
    )
    return {"ok": ok}


@router.get(
    "/audit-log",
    response_model=list[AdminAuditLogOut],
    dependencies=[Depends(require_admin)],
)
def audit_log(
    limit: int = Query(100, ge=1, le=500),
    actor: str | None = None,
    action_prefix: str | None = None,
    since: datetime | None = None,
) -> list[AdminAuditLogOut]:
    rows = store.recent_admin_actions(
        limit=limit,
        actor=actor,
        action_prefix=action_prefix,
        since=since,
    )
    return [_to_audit_out(r) for r in rows]


def _to_audit_out(r: AuditLogEntry) -> AdminAuditLogOut:
    return AdminAuditLogOut(
        id=r.id,
        actor_email=r.actor_email,
        actor_role=r.actor_role,
        action=r.action,
        target_type=r.target_type,
        target_id=r.target_id,
        details=r.details or {},
        occurred_at=r.occurred_at,
    )
