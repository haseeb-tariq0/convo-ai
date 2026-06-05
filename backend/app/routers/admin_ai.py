"""Per-client AI integration admin routes.

Endpoints (all require Bearer admin token):
  PUT    /api/admin/clients/{id}/ai           Set/update the integration
  GET    /api/admin/clients/{id}/ai           Read (masked key)
  DELETE /api/admin/clients/{id}/ai           Remove
  POST   /api/admin/clients/{id}/ai/test      Smoke-test the configured key

Security model:
  * api_key flows IN as plaintext, encrypted at rest before storage.
  * api_key is NEVER returned plaintext — GET responses include
    `api_key_masked` ("sk-…AAAA") only.
  * Rotation = PUT with a new key.
"""
import time

from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import AdminPrincipal, current_admin, require_admin
from ..schemas.ai_integration import AIIntegrationIn, AIIntegrationOut, AITestResult
from ..services import audit, encryption
from ..services import ai as ai_service
from ..store import AIIntegration, store

router = APIRouter(
    prefix="/api/admin/clients/{client_id}/ai",
    tags=["admin/ai"],
    dependencies=[Depends(require_admin)],
)


def _serialize(integration: AIIntegration) -> AIIntegrationOut:
    # The store holds the Fernet ciphertext. We decrypt only to compute
    # the masked display value — never expose the raw key in responses.
    try:
        plain = encryption.decrypt(integration.api_key_encrypted)
        masked = encryption.mask(plain)
    except ValueError:
        # If decryption fails (rotated key, corrupted row), show a clear
        # sentinel rather than crashing the entire response.
        masked = "[decryption failed — re-set the key]"
    return AIIntegrationOut(
        id=integration.id,
        client_id=integration.client_id,
        provider=integration.provider,  # type: ignore[arg-type]  pydantic Literal narrows
        api_key_masked=masked,
        model=integration.model,
        is_active=integration.is_active,
        last_used_at=integration.last_used_at,
        created_at=integration.created_at,
        updated_at=integration.updated_at,
    )


@router.put("", response_model=AIIntegrationOut)
def upsert(
    client_id: str,
    payload: AIIntegrationIn,
    principal: AdminPrincipal = Depends(current_admin),
) -> AIIntegrationOut:
    if not store.get_client(client_id):
        raise HTTPException(status_code=404, detail="client not found")
    ciphertext = encryption.encrypt(payload.api_key)
    integration = store.upsert_ai(
        client_id,
        provider=payload.provider,
        api_key_encrypted=ciphertext,
        model=payload.model,
        is_active=payload.is_active,
    )
    audit.log_action(
        principal,
        "ai.upsert",
        target_type="ai",
        target_id=integration.id,
        provider=payload.provider,
        client_id=client_id,
    )
    return _serialize(integration)


@router.get("", response_model=AIIntegrationOut)
def read(client_id: str) -> AIIntegrationOut:
    integration = store.get_ai_for_client(client_id)
    if not integration:
        raise HTTPException(status_code=404, detail="ai integration not configured")
    return _serialize(integration)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def delete(
    client_id: str,
    principal: AdminPrincipal = Depends(current_admin),
) -> None:
    if not store.delete_ai(client_id):
        raise HTTPException(status_code=404, detail="ai integration not configured")
    audit.log_action(
        principal,
        "ai.delete",
        target_type="ai",
        target_id=client_id,
    )


@router.post("/test", response_model=AITestResult)
def test(client_id: str) -> AITestResult:
    """Fire one cheap label request against the client's configured key.
    Useful as a Save-and-Test affordance in the admin UI.

    Cost: one API call (~$0.0001 at gpt-4o-mini pricing). Returns
    `ok=false` with the error message instead of HTTP 500 so the
    frontend can render the failure inline without a noisy toast."""
    integration = store.get_ai_for_client(client_id)
    if not integration:
        raise HTTPException(status_code=404, detail="ai integration not configured")
    sample = "Hi, can I check in early tomorrow?"
    t0 = time.monotonic()
    try:
        results = ai_service.label_messages_for_client(client_id, [sample])
    except Exception as e:  # noqa: BLE001
        return AITestResult(
            ok=False,
            provider=integration.provider,  # type: ignore[arg-type]
            model=integration.model or "(default)",
            latency_ms=int((time.monotonic() - t0) * 1000),
            error=f"{type(e).__name__}: {e}",
        )
    latency_ms = int((time.monotonic() - t0) * 1000)
    first = results[0] if results else {}
    return AITestResult(
        ok=True,
        provider=integration.provider,  # type: ignore[arg-type]
        model=integration.model or "(default)",
        latency_ms=latency_ms,
        sample_sentiment=first.get("sentiment"),
        sample_topics=first.get("topics") or [],
    )
