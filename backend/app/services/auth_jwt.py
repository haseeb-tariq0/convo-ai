"""Supabase user-JWT verification.

We verify the token by calling Supabase's `/auth/v1/user` endpoint with
the bearer token + the project's anon key. If 200, the token is valid
and we get the user object (email, id, metadata). If anything else, the
token is rejected.

This is simpler than verifying the JWT signature locally — Supabase
manages key rotation, expiry checks, etc. — at the cost of one HTTP
round-trip per uncached request. We cache verified tokens in-memory for
60 seconds (well under the default 1-hour Supabase token lifetime) so a
typical admin session is effectively local-only after the first call.

If you'd rather verify locally:
  - Symmetric mode: grab the Project Settings → API → JWT Secret and
    use `jwt.decode(token, secret, algorithms=['HS256'], audience='authenticated')`.
  - Asymmetric mode: hit `{SUPABASE_URL}/.well-known/jwks.json` and use
    PyJWT's PyJWKClient. (Supabase rolled out RS256 in mid-2025.)
Either way, the contract this module exposes — `verify_supabase_user`
returning a dict-or-None — stays the same.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)

# Tuple of (expires_at_epoch_seconds, user_payload).
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_cache_lock = threading.Lock()
_CACHE_TTL_SECONDS = 60


def _cache_get(token: str) -> dict[str, Any] | None:
    with _cache_lock:
        entry = _cache.get(token)
        if not entry:
            return None
        expires, payload = entry
        if expires < time.time():
            _cache.pop(token, None)
            return None
        return payload


def _cache_put(token: str, payload: dict[str, Any]) -> None:
    with _cache_lock:
        _cache[token] = (time.time() + _CACHE_TTL_SECONDS, payload)
        # Cheap GC: when the cache hits ~200 entries, prune the expired
        # ones. The cap is generous — admin sessions are small.
        if len(_cache) > 200:
            now = time.time()
            for k in [k for k, (exp, _) in _cache.items() if exp < now]:
                _cache.pop(k, None)


def verify_supabase_user(token: str) -> dict[str, Any] | None:
    """Validate a Supabase-issued user JWT. Returns the user object on
    success (dict with `email`, `id`, `aud`, etc.) or None if the token
    is missing, malformed, expired, or rejected by Supabase.

    Never raises — auth failures are non-exceptional. Callers branch on
    the truthiness of the return value.
    """
    settings = get_settings()
    if not token or not settings.supabase_url or not settings.supabase_anon_key:
        return None

    cached = _cache_get(token)
    if cached is not None:
        return cached

    url = f"{settings.supabase_url.rstrip('/')}/auth/v1/user"
    try:
        resp = httpx.get(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": settings.supabase_anon_key,
            },
            timeout=5.0,
        )
    except httpx.HTTPError as e:
        # Network blip — don't crash the request, just refuse the token.
        log.warning("supabase /auth/v1/user request failed: %s", e)
        return None

    if resp.status_code != 200:
        return None
    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(payload, dict) or not payload.get("email"):
        return None
    _cache_put(token, payload)
    return payload


# Per-email (allowed?, role) cache. Populated on every successful
# admin_users lookup; survives transient socket errors (WinError 10035
# "non-blocking socket would block" on Windows under HTTP/2 pressure)
# that would otherwise drop the user back to env-only auth and lose
# their super_admin role mid-session. 5-minute TTL — short enough that
# a real role change in the DB shows up quickly, long enough to bridge
# any flaky network blip.
_ROLE_CACHE_TTL_SECONDS = 300
_role_cache: dict[str, tuple[float, bool, str | None]] = {}
_role_cache_lock = threading.Lock()


def _role_cache_put(needle: str, allowed: bool, role: str | None) -> None:
    with _role_cache_lock:
        _role_cache[needle] = (time.time() + _ROLE_CACHE_TTL_SECONDS, allowed, role)


def _role_cache_get(needle: str) -> tuple[bool, str | None] | None:
    with _role_cache_lock:
        entry = _role_cache.get(needle)
        if not entry:
            return None
        expires, allowed, role = entry
        if expires < time.time():
            _role_cache.pop(needle, None)
            return None
        return allowed, role


def _lookup_admin_rows() -> list:
    """Single retry of the admin_users list query — bridges the
    transient `WinError 10035 / would-block` socket errors we see on
    Windows under HTTP/2 load. Falls back to [] on persistent failure."""
    from ..store import store
    for attempt in (1, 2):
        try:
            return store.list_admin_users(include_inactive=False)
        except Exception as e:  # noqa: BLE001
            log.warning(
                "admin_users lookup failed (attempt %d): %s", attempt, e,
            )
    return []


def is_allowed_admin_email(email: str | None) -> bool:
    """Check if a verified email is in the admin allowlist.

    Lookup priority:
      1. In-memory role cache (5-minute TTL) — survives transient DB
         hiccups so mid-session auth doesn't flap.
      2. `admin_users` table (where is_active=true) — the canonical
         allowlist after the 0010 migration. Editable live via the
         admin Users page.
      3. `ADMIN_EMAILS` env var — bootstrap fallback for fresh installs
         where the table is empty (so we don't lock ourselves out on
         first boot). Once any row exists in admin_users, this fallback
         stops mattering.

    Returns False when the email isn't found in any source.
    """
    if not email:
        return False
    needle = email.strip().lower()

    cached = _role_cache_get(needle)
    if cached is not None:
        return cached[0]

    rows = _lookup_admin_rows()
    if rows:
        for u in rows:
            row_email = (u.email or "").strip().lower()
            # Populate the cache for EVERY known admin while we're
            # here — saves a round-trip on each user's next request.
            _role_cache_put(row_email, True, u.role)
        return any((u.email or "").strip().lower() == needle for u in rows)

    # Bootstrap fallback — only fires when admin_users is empty OR the
    # lookup just failed twice. In the failure-retry case we DON'T
    # cache (would mask a real outage forever).
    settings = get_settings()
    allowlist = settings.admin_email_set
    return needle in allowlist


def get_admin_role(email: str | None) -> str | None:
    """Resolve the role ('super_admin' | 'admin') for a verified email.

    Order:
      1. In-memory cache (populated by `is_allowed_admin_email` on
         every successful list). Bridges transient DB hiccups.
      2. Direct DB lookup (retried once on transient error).
      3. None — the caller treats that as 'admin' (no super_admin
         escalation on missing data).
    """
    if not email:
        return None
    needle = email.strip().lower()

    cached = _role_cache_get(needle)
    if cached is not None:
        return cached[1]

    from ..store import store
    for attempt in (1, 2):
        try:
            row = store.get_admin_user_by_email(needle)
            if row and row.is_active:
                _role_cache_put(needle, True, row.role)
                return row.role
            # Found a row but inactive (or no row at all) — that's a
            # definitive "no", cache it negatively to avoid hammering.
            _role_cache_put(needle, False, None)
            return None
        except Exception as e:  # noqa: BLE001
            log.warning(
                "get_admin_user_by_email failed (attempt %d): %s", attempt, e,
            )
    return None
