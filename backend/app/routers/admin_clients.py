from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import AdminPrincipal, current_admin, require_admin
from ..schemas.client import ClientCreate, ClientOut, ClientUpdate
from ..services import audit
from ..store import store

router = APIRouter(prefix="/api/admin/clients", tags=["admin/clients"], dependencies=[Depends(require_admin)])


def _serialize(c) -> ClientOut:
    return ClientOut(
        id=c.id,
        name=c.name,
        contact_email=c.contact_email,
        is_active=c.is_active,
        brand_name=c.brand_name,
        brand_logo_url=c.brand_logo_url,
        brand_primary_color=c.brand_primary_color,
        brand_accent_color=c.brand_accent_color,
        created_at=c.created_at,
        updated_at=c.updated_at,
    )


@router.post("", response_model=ClientOut, status_code=status.HTTP_201_CREATED)
def create(
    payload: ClientCreate,
    principal: AdminPrincipal = Depends(current_admin),
) -> ClientOut:
    c = store.create_client(name=payload.name, contact_email=payload.contact_email)
    audit.log_action(
        principal,
        "client.create",
        target_type="client",
        target_id=c.id,
        name=c.name,
    )
    return _serialize(c)


@router.get("", response_model=list[ClientOut])
def list_all(include_inactive: bool = False) -> list[ClientOut]:
    return [_serialize(c) for c in store.list_clients(include_inactive=include_inactive)]


@router.get("/{client_id}", response_model=ClientOut)
def read(client_id: str) -> ClientOut:
    c = store.get_client(client_id)
    if not c:
        raise HTTPException(status_code=404, detail="client not found")
    return _serialize(c)


@router.patch("/{client_id}", response_model=ClientOut)
def update(
    client_id: str,
    payload: ClientUpdate,
    principal: AdminPrincipal = Depends(current_admin),
) -> ClientOut:
    c = store.update_client(client_id, **payload.model_dump(exclude_unset=True))
    if not c:
        raise HTTPException(status_code=404, detail="client not found")
    audit.log_action(
        principal,
        "client.update",
        target_type="client",
        target_id=client_id,
        changed=list(payload.model_dump(exclude_unset=True).keys()),
    )
    return _serialize(c)


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
def soft_delete(
    client_id: str,
    principal: AdminPrincipal = Depends(current_admin),
) -> None:
    ok = store.deactivate_client(client_id)
    if not ok:
        raise HTTPException(status_code=404, detail="client not found")
    audit.log_action(
        principal,
        "client.delete",
        target_type="client",
        target_id=client_id,
    )
