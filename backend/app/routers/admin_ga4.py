from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import AdminPrincipal, current_admin, require_admin
from ..schemas.ga4 import GA4ConfigIn, GA4ConfigOut
from ..services import audit, encryption, ga4
from ..store import store

router = APIRouter(
    prefix="/api/admin/clients/{client_id}/ga4",
    tags=["admin/ga4"],
    dependencies=[Depends(require_admin)],
)


def _serialize(g) -> GA4ConfigOut:
    return GA4ConfigOut(
        id=g.id,
        client_id=g.client_id,
        property_id=g.property_id,
        conversion_event_name=g.conversion_event_name,
        lookback_days=g.lookback_days,
        sync_users=g.sync_users,
        sync_pageviews=g.sync_pageviews,
        sync_events=g.sync_events,
        sync_conversions=g.sync_conversions,
        sync_traffic_sources=g.sync_traffic_sources,
        sync_devices=g.sync_devices,
        last_synced_at=g.last_synced_at,
    )


@router.put("", response_model=GA4ConfigOut)
def upsert(
    client_id: str,
    payload: GA4ConfigIn,
    principal: AdminPrincipal = Depends(current_admin),
) -> GA4ConfigOut:
    if not store.get_client(client_id):
        raise HTTPException(status_code=404, detail="client not found")
    # Encrypt the service-account JSON before it lands in the DB.
    # services/ga4.py decrypts on the fly when calling Google. Legacy
    # plaintext rows keep working via decrypt_or_passthrough.
    data = payload.model_dump()
    if data.get("credentials_json"):
        data["credentials_json"] = encryption.encrypt(data["credentials_json"])
    else:
        # Blank → use the global Nexa service account; don't overwrite any
        # explicitly-saved per-client key.
        data.pop("credentials_json", None)
    g = store.upsert_ga4(client_id, **data)
    audit.log_action(
        principal,
        "ga4.upsert",
        target_type="ga4",
        target_id=g.id,
        client_id=client_id,
        property_id=g.property_id,
    )
    return _serialize(g)


@router.get("", response_model=GA4ConfigOut)
def read(client_id: str) -> GA4ConfigOut:
    g = store.get_ga4_for_client(client_id)
    if not g:
        raise HTTPException(status_code=404, detail="ga4 integration not configured")
    return _serialize(g)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def delete(
    client_id: str,
    principal: AdminPrincipal = Depends(current_admin),
) -> None:
    if not store.delete_ga4(client_id):
        raise HTTPException(status_code=404, detail="ga4 integration not configured")
    audit.log_action(
        principal,
        "ga4.delete",
        target_type="ga4",
        target_id=client_id,
    )


@router.post("/sync")
def manual_sync(
    client_id: str,
    principal: AdminPrincipal = Depends(current_admin),
) -> dict:
    g = store.get_ga4_for_client(client_id)
    if not g:
        raise HTTPException(status_code=404, detail="ga4 integration not configured")
    ga4.sync_integration(g)
    audit.log_action(
        principal,
        "ga4.sync_now",
        target_type="ga4",
        target_id=g.id,
        client_id=client_id,
        property_id=g.property_id,
    )
    return {"status": "ok"}
