"""Admin action audit log.

Single tiny helper called explicitly from every mutating admin endpoint
(client create/update/delete, dashboard create/delete/sync/rotate-token,
ga4 upsert/delete/sync, ai upsert/delete, admin invite/role-change/
remove/signout). The actor info comes from `current_admin` — handlers
that need to audit add `principal: AdminPrincipal = Depends(current_admin)`
to their signature.

Why a helper and not a middleware/decorator:
  - The action name + target_id often come from the route's own data
    after the mutation succeeds (e.g. `client.create` only knows the
    new ID after the store call).
  - Explicit calls keep the audit close to the work, so a future
    reader can grep `audit.log_action` to see what's being tracked.
  - Wraps in try/except so a logging failure NEVER blocks the request.
"""
from __future__ import annotations

import logging
from typing import Any

from ..auth import AdminPrincipal
from ..store import store

log = logging.getLogger(__name__)


def log_action(
    principal: AdminPrincipal,
    action: str,
    *,
    target_type: str | None = None,
    target_id: str | None = None,
    **details: Any,
) -> None:
    """Append one row to `admin_audit_log`. Best-effort — swallows any
    storage error and logs at warning level so the request never fails
    because we couldn't record what happened.

    Args:
      principal: from `Depends(current_admin)`. Bearer-token callers
                 (no identity) are recorded as actor_email='(token)'.
      action:    dot-namespaced action name, e.g. 'client.create',
                 'dashboard.delete', 'admin.invite'.
      target_type: 'client' | 'dashboard' | 'ga4' | 'ai' | 'admin_user'
                  | None — what kind of object was acted on.
      target_id:  the UUID / share-token / email of the target.
      **details: arbitrary extra context, written to the JSONB
                 `details` column. Keep it small + structured (no PII).
    """
    try:
        store.log_admin_action(
            actor_email=principal.get("email") or "(token)",
            actor_role=principal.get("role"),
            action=action,
            target_type=target_type,
            target_id=target_id,
            details=details or None,
        )
    except Exception as e:  # noqa: BLE001 — never break the request
        log.warning(
            "audit log_action failed (action=%s target=%s/%s): %s",
            action, target_type, target_id, e,
        )
