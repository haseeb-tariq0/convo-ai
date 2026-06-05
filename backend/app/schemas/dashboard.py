from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class DashboardCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    sheet_id: str | None = None
    sheet_tab_name: str = "Sheet1"
    sheet_column_map: dict[str, str] = Field(default_factory=dict)
    field_config: list[dict[str, Any]] = Field(default_factory=list)
    poll_interval_seconds: int = Field(default=30, ge=10, le=3600)
    brand_name: str | None = None
    brand_logo_url: str | None = None
    brand_primary_color: str | None = None
    brand_accent_color: str | None = None
    layout_config: dict[str, Any] | None = None


class DashboardUpdate(BaseModel):
    name: str | None = None
    sheet_id: str | None = None
    sheet_tab_name: str | None = None
    sheet_column_map: dict[str, str] | None = None
    field_config: list[dict[str, Any]] | None = None
    poll_interval_seconds: int | None = Field(default=None, ge=10, le=3600)
    is_active: bool | None = None
    brand_name: str | None = None
    brand_logo_url: str | None = None
    brand_primary_color: str | None = None
    brand_accent_color: str | None = None
    layout_config: dict[str, Any] | None = None


class DashboardOut(BaseModel):
    id: str
    client_id: str
    name: str
    share_token: str
    sheet_id: str | None
    sheet_tab_name: str
    sheet_column_map: dict[str, str]
    field_config: list[dict[str, Any]]
    poll_interval_seconds: int
    is_active: bool
    brand_name: str | None = None
    brand_logo_url: str | None = None
    brand_primary_color: str | None = None
    brand_accent_color: str | None = None
    layout_config: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime


class SyncLogOut(BaseModel):
    id: str
    source: str
    status: str
    message: str
    rows_processed: int | None
    duration_ms: int | None
    occurred_at: datetime
