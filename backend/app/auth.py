"""Admin authorization. Two paths, tried in order:

1. **Shared bearer token** (`ADMIN_TOKEN`) — legacy / CLI / CI / curl.
   Kept so scripts and automation don't break when OAuth lands. Tokens
   carry no identity → `role` is None on the principal.
2. **Supabase user JWT** + DB allowlist (`admin_users` table, with
   env-var bootstrap fallback) — what the browser admin UI uses after
   the Google OAuth dance. The matching admin_users row supplies the
   role ('super_admin' | 'admin').

Either succeeds → endpoint is allowed. Both fail → 401 (or 403 when
the email is verified but not on the allowlist).

The `require_admin` dependency stays a no-arg sentinel so existing
routers don't need to change. If a router needs to know WHO is making
the call (for audit logging or role gating), it uses `current_admin`
instead, which returns either {"kind": "token"} or
{"kind": "user", "email": …, "user_id": …, "role": …}.

For super_admin-only endpoints (manage other admins), depend on
`require_super_admin` which 403s legacy tokens AND regular admins.
"""
from __future__ import annotations

import hmac
import logging
from typing import TypedDict

from fastapi import Depends, Header, HTTPException, status

from .config import Settings, get_settings
from .services.auth_jwt import (
    get_admin_role,
    is_allowed_admin_email,
    verify_supabase_user,
)

log = logging.getLogger(__name__)


class AdminPrincipal(TypedDict, total=False):
    kind: str          # "token" | "user"
    email: str         # set when kind == "user"
    user_id: str       # set when kind == "user" (Supabase user UUID)
    role: str          # set when kind == "user" — 'super_admin' | 'admin'


def _try_bearer(presented: str, expected: str) -> bool:
    """Constant-time bearer-token comparison. Avoids leaking length via
    timing even though the secret is shared."""
    if not presented or not expected:
        return False
    return hmac.compare_digest(presented, expected)


def current_admin(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> AdminPrincipal:
    """Returns the resolved principal — useful for endpoints that need
    to know whether the caller is OAuth-authenticated (and who they
    are) vs an automation script. Raises 401 if neither path validates,
    403 if a valid Google user isn't on the allowlist.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing bearer token",
        )
    presented = authorization.split(" ", 1)[1].strip()

    # Path 1: shared admin token (legacy / CLI fallback). No identity, no role.
    if _try_bearer(presented, settings.admin_token):
        return {"kind": "token"}

    # Path 2: Supabase-issued user JWT. Verify the signature via
    # /auth/v1/user (cached 60s), then check the email allowlist + look
    # up the role from admin_users.
    user = verify_supabase_user(presented)
    if user and is_allowed_admin_email(user.get("email")):
        email = str(user.get("email") or "").lower()
        user_id = str(user.get("id") or "")
        role = get_admin_role(email) or "admin"

        # Best-effort: refresh last_signed_in_at + link supabase_user_id
        # so the admin Users page shows live activity. Never blocks auth.
        try:
            from .store import store
            store.touch_admin_user_signin(email, user_id)
        except Exception as e:  # noqa: BLE001
            log.debug("touch_admin_user_signin failed: %s", e)

        return {
            "kind": "user",
            "email": email,
            "user_id": user_id,
            "role": role,
        }

    # Distinguish "valid Google login but not on the allowlist" from
    # "bad token" so a misconfigured admin sees a useful error.
    if user and user.get("email"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"{user.get('email')} is not authorized for admin access. "
                "Ask a super_admin to invite you from the Admins page."
            ),
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid bearer token",
    )


def require_admin(_: AdminPrincipal = Depends(current_admin)) -> None:
    """Thin sentinel wrapper kept for backward-compat. Routers that
    used `Depends(require_admin)` keep working; new routers that need
    the principal object can switch to `Depends(current_admin)`."""
    return None


def require_super_admin(p: AdminPrincipal = Depends(current_admin)) -> AdminPrincipal:
    """Gate for endpoints that manage OTHER admins (invite, role-change,
    remove, force-signout).

    Accepts EITHER:
      - kind='token' (legacy ADMIN_TOKEN bearer) — it bypasses every
        other check anyway, so treating it as super_admin here is
        consistent. Used by CLI scripts / CI.
      - kind='user' AND role='super_admin' — the OAuth flow.

    Returns the principal so handlers can audit-log the actor without
    re-resolving it."""
    if p.get("kind") == "token":
        return p
    if p.get("kind") == "user" and p.get("role") == "super_admin":
        return p
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="super_admin role required",
    )
