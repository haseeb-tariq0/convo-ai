from datetime import datetime
from typing import Any

from pydantic import BaseModel


class PublicDashboardConfig(BaseModel):
    # Internal UUID — exposed so admin-authenticated clients can call
    # PATCH /api/admin/dashboards/{id} from the public view (used by the
    # in-page layout editor). Disclosing it is harmless: mutations still
    # require the admin bearer, and the share_token in the URL is no
    # less sensitive than this UUID.
    id: str
    name: str
    field_config: list[dict[str, Any]]
    last_updated_at: datetime | None
    # Per-dashboard branding — all optional. Frontend falls back to the
    # editorial defaults when these are null.
    brand_name: str | None = None
    brand_logo_url: str | None = None
    brand_primary_color: str | None = None
    brand_accent_color: str | None = None
    # Section order + visibility for the magazine layout. Null → full default.
    layout_config: dict[str, Any] | None = None


class PublicFieldValue(BaseModel):
    id: str
    type: str
    label: str
    value: Any  # shape depends on type; the renderer dispatches.


class PublicDashboardData(BaseModel):
    fields: list[PublicFieldValue]
    generated_at: datetime
