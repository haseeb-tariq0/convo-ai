from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import AdminPrincipal, current_admin, require_admin
from ..schemas.dashboard import DashboardCreate, DashboardOut, DashboardUpdate, SyncLogOut
from ..services import audit, sheets
from ..store import store

router = APIRouter(prefix="/api/admin", tags=["admin/dashboards"], dependencies=[Depends(require_admin)])


def _serialize(d) -> DashboardOut:
    return DashboardOut(
        id=d.id,
        client_id=d.client_id,
        name=d.name,
        share_token=d.share_token,
        sheet_id=d.sheet_id,
        sheet_tab_name=d.sheet_tab_name,
        sheet_column_map=d.sheet_column_map,
        field_config=d.field_config,
        poll_interval_seconds=d.poll_interval_seconds,
        is_active=d.is_active,
        brand_name=d.brand_name,
        brand_logo_url=d.brand_logo_url,
        brand_primary_color=d.brand_primary_color,
        brand_accent_color=d.brand_accent_color,
        layout_config=getattr(d, "layout_config", None),
        created_at=d.created_at,
        updated_at=d.updated_at,
    )


@router.post(
    "/clients/{client_id}/dashboards",
    response_model=DashboardOut,
    status_code=status.HTTP_201_CREATED,
)
def create_dashboard(
    client_id: str,
    payload: DashboardCreate,
    principal: AdminPrincipal = Depends(current_admin),
) -> DashboardOut:
    if not store.get_client(client_id):
        raise HTTPException(status_code=404, detail="client not found")
    d = store.create_dashboard(
        client_id=client_id,
        **payload.model_dump(),
    )
    audit.log_action(
        principal,
        "dashboard.create",
        target_type="dashboard",
        target_id=d.id,
        client_id=client_id,
        name=d.name,
    )
    return _serialize(d)


@router.get("/clients/{client_id}/dashboards", response_model=list[DashboardOut])
def list_for_client(client_id: str) -> list[DashboardOut]:
    if not store.get_client(client_id):
        raise HTTPException(status_code=404, detail="client not found")
    return [_serialize(d) for d in store.list_dashboards_for_client(client_id)]


@router.get("/dashboards/{dashboard_id}", response_model=DashboardOut)
def read(dashboard_id: str) -> DashboardOut:
    d = store.get_dashboard(dashboard_id)
    if not d:
        raise HTTPException(status_code=404, detail="dashboard not found")
    return _serialize(d)


@router.patch("/dashboards/{dashboard_id}", response_model=DashboardOut)
def update(
    dashboard_id: str,
    payload: DashboardUpdate,
    principal: AdminPrincipal = Depends(current_admin),
) -> DashboardOut:
    d = store.update_dashboard(dashboard_id, **payload.model_dump(exclude_unset=True))
    if not d:
        raise HTTPException(status_code=404, detail="dashboard not found")
    audit.log_action(
        principal,
        "dashboard.update",
        target_type="dashboard",
        target_id=dashboard_id,
        changed=list(payload.model_dump(exclude_unset=True).keys()),
    )
    return _serialize(d)


@router.delete("/dashboards/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete(
    dashboard_id: str,
    principal: AdminPrincipal = Depends(current_admin),
) -> None:
    if not store.delete_dashboard(dashboard_id):
        raise HTTPException(status_code=404, detail="dashboard not found")
    audit.log_action(
        principal,
        "dashboard.delete",
        target_type="dashboard",
        target_id=dashboard_id,
    )


@router.post("/dashboards/{dashboard_id}/sync")
def manual_sync(
    dashboard_id: str,
    principal: AdminPrincipal = Depends(current_admin),
) -> dict:
    if not store.get_dashboard(dashboard_id):
        raise HTTPException(status_code=404, detail="dashboard not found")
    added = sheets.manual_sync(dashboard_id)
    # Kick AI immediately so the new rows light up.
    from ..services import ai
    ai.process_pending_rows()
    audit.log_action(
        principal,
        "dashboard.sync_now",
        target_type="dashboard",
        target_id=dashboard_id,
        rows_added=added,
    )
    return {"rows_added": added}


@router.post("/dashboards/{dashboard_id}/rotate-token", response_model=DashboardOut)
def rotate_token(
    dashboard_id: str,
    principal: AdminPrincipal = Depends(current_admin),
) -> DashboardOut:
    d = store.rotate_share_token(dashboard_id)
    if not d:
        raise HTTPException(status_code=404, detail="dashboard not found")
    audit.log_action(
        principal,
        "dashboard.rotate_token",
        target_type="dashboard",
        target_id=dashboard_id,
    )
    return _serialize(d)


@router.get("/dashboards/{dashboard_id}/logs", response_model=list[SyncLogOut])
def recent_logs(dashboard_id: str, limit: int = 50) -> list[SyncLogOut]:
    if not store.get_dashboard(dashboard_id):
        raise HTTPException(status_code=404, detail="dashboard not found")
    return [
        SyncLogOut(
            id=l.id,
            source=l.source,
            status=l.status,
            message=l.message,
            rows_processed=l.rows_processed,
            duration_ms=l.duration_ms,
            occurred_at=l.occurred_at,
        )
        for l in store.recent_logs_for_dashboard(dashboard_id, limit=limit)
    ]
