"""Supabase Admin API client.

Thin httpx wrapper around the `/auth/v1/admin/*` endpoints we use from
the admin Users page: invite new admins (sends magic-link email),
delete users, force sign-out, and list active sessions.

Authentication uses the service-role key from `SUPABASE_SERVICE_ROLE_KEY`
(NEVER the anon key — these endpoints require the bypass-RLS service
role). Same header pattern as `services/auth_jwt.py`: `Authorization:
Bearer <key>` + `apikey: <key>`.

Everything returns dict-or-None / bool — we never raise on auth or
network errors so the calling routes can surface clean error messages
to the admin UI.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)

# Match what services/auth_jwt.py uses so we don't have wildly different
# timeouts across the codebase. 8s leaves headroom for occasional
# Supabase warmups without hanging an admin click for too long.
_TIMEOUT = 8.0


def _admin_headers() -> dict[str, str]:
    """Service-role auth headers. Same key used for `apikey` AND
    `Authorization` — that's how Supabase admin endpoints expect it."""
    s = get_settings()
    key = s.supabase_service_role_key
    return {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "application/json",
    }


def _base_url() -> str | None:
    """Returns the admin API base, or None if Supabase isn't configured.
    Callers MUST handle None — typically by raising a 503 / 500 with a
    clear "Supabase not configured" message."""
    s = get_settings()
    if not s.supabase_url or not s.supabase_service_role_key:
        return None
    return f"{s.supabase_url.rstrip('/')}/auth/v1/admin"


def invite_user(email: str, *, redirect_to: str | None = None) -> dict[str, Any] | None:
    """Send a magic-link invite email. Supabase generates a one-time
    token, emails the user, and on click takes them to `redirect_to`
    (defaults to FRONTEND_URL + /admin so they land in our app
    signed in).

    Returns the created user object on success, None on failure.
    Failure surfaces logging — the route translates to a clean 4xx.
    """
    base = _base_url()
    if not base:
        log.warning("invite_user: Supabase not configured")
        return None
    settings = get_settings()
    target = redirect_to or f"{settings.frontend_url.rstrip('/')}/admin"
    try:
        resp = httpx.post(
            f"{base}/invite",
            headers=_admin_headers(),
            json={"email": email, "redirect_to": target},
            timeout=_TIMEOUT,
        )
    except httpx.HTTPError as e:
        log.warning("invite_user network error for %s: %s", email, e)
        return None
    if resp.status_code not in (200, 201):
        # Supabase returns helpful error JSON; surface the message but
        # don't expose to the admin UI — just log + return None.
        log.warning(
            "invite_user %s failed: %s %s",
            email, resp.status_code, resp.text[:200],
        )
        return None
    try:
        return resp.json()
    except Exception:  # noqa: BLE001
        return None


def delete_user(supabase_user_id: str) -> bool:
    """Permanently delete a Supabase auth user. Use when soft-deleting
    an admin_users row — keeps the two stores in sync. Returns True
    on success (200/204), False otherwise.

    Idempotent: a 404 on the Supabase side (user already gone) also
    returns True so a retry from the UI doesn't look like an error.
    """
    base = _base_url()
    if not base or not supabase_user_id:
        return False
    try:
        resp = httpx.delete(
            f"{base}/users/{supabase_user_id}",
            headers=_admin_headers(),
            timeout=_TIMEOUT,
        )
    except httpx.HTTPError as e:
        log.warning("delete_user network error for %s: %s", supabase_user_id, e)
        return False
    if resp.status_code in (200, 204, 404):
        return True
    log.warning(
        "delete_user %s failed: %s %s",
        supabase_user_id, resp.status_code, resp.text[:200],
    )
    return False


def sign_out_user(supabase_user_id: str) -> bool:
    """Force-sign-out a user — invalidates ALL their refresh tokens.
    Their current access token stays valid until its JWT exp claim
    (typically ~1 hour); refresh fails immediately so the next refresh
    cycle kicks them out.

    Endpoint: POST /auth/v1/admin/users/{id}/logout
    Returns True on success or a 404 (user already gone)."""
    base = _base_url()
    if not base or not supabase_user_id:
        return False
    try:
        resp = httpx.post(
            f"{base}/users/{supabase_user_id}/logout",
            headers=_admin_headers(),
            timeout=_TIMEOUT,
        )
    except httpx.HTTPError as e:
        log.warning("sign_out_user network error for %s: %s", supabase_user_id, e)
        return False
    if resp.status_code in (200, 204, 404):
        return True
    log.warning(
        "sign_out_user %s failed: %s %s",
        supabase_user_id, resp.status_code, resp.text[:200],
    )
    return False


def get_user(supabase_user_id: str) -> dict[str, Any] | None:
    """Fetch a single user object — used to enrich the admin Users list
    with full_name + avatar_url from `user_metadata`. Returns None if
    the user doesn't exist or Supabase isn't reachable."""
    base = _base_url()
    if not base or not supabase_user_id:
        return None
    try:
        resp = httpx.get(
            f"{base}/users/{supabase_user_id}",
            headers=_admin_headers(),
            timeout=_TIMEOUT,
        )
    except httpx.HTTPError as e:
        log.warning("get_user network error for %s: %s", supabase_user_id, e)
        return None
    if resp.status_code != 200:
        return None
    try:
        return resp.json()
    except Exception:  # noqa: BLE001
        return None


def active_session_user_ids(within_seconds: int = 3600) -> set[str]:
    """Return the set of Supabase user IDs whose `auth.sessions.updated_at`
    is within the last `within_seconds`. Used to flag "currently online"
    pulses on the admin Users page.

    Implemented via PostgREST RPC against an inline SQL query through
    Supabase's PostgREST — but PostgREST doesn't expose `auth` schema
    to anon, so we go through the service-role's direct DB access.

    Cheaper option in practice: list all sessions and filter client-
    side. That's what we do here.
    """
    base = _base_url()
    if not base:
        return set()
    s = get_settings()
    # auth.sessions isn't exposed via PostgREST by default. Use the
    # Supabase admin /sessions endpoint where available, OR query
    # auth.users (last_sign_in_at) as a coarse proxy. The latter is
    # always available and is good enough for "online" pulses.
    try:
        resp = httpx.get(
            f"{base}/users?per_page=1000",
            headers=_admin_headers(),
            timeout=_TIMEOUT,
        )
    except httpx.HTTPError as e:
        log.warning("active_session_user_ids network error: %s", e)
        return set()
    if resp.status_code != 200:
        return set()
    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return set()
    users = payload.get("users", []) if isinstance(payload, dict) else []
    from datetime import datetime, timezone, timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=within_seconds)
    online: set[str] = set()
    for u in users:
        last = u.get("last_sign_in_at")
        if not last:
            continue
        try:
            ts = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
        except ValueError:
            continue
        if ts >= cutoff:
            online.add(str(u.get("id") or ""))
    return online
