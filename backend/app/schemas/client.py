from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class ClientCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    contact_email: EmailStr | None = None


class ClientUpdate(BaseModel):
    """PATCH /api/admin/clients/{id}. All fields optional — the router
    only applies the ones that were set in the request body."""
    name: str | None = Field(default=None, min_length=1, max_length=200)
    contact_email: EmailStr | None = None
    is_active: bool | None = None
    # Branding defaults — inherited by every dashboard unless that
    # dashboard sets its own brand_* override.
    brand_name: str | None = None
    # `brand_logo_url` can be a normal https://… URL OR an inline
    # data: URI (e.g. "data:image/png;base64,…"), which is how the file
    # upload UI sends locally-picked logos until a real storage bucket
    # is wired up. No length cap — Pydantic's str default handles
    # ~100KB data URIs comfortably.
    brand_logo_url: str | None = None
    brand_primary_color: str | None = None
    brand_accent_color: str | None = None


class ClientOut(BaseModel):
    id: str
    name: str
    contact_email: str | None
    is_active: bool
    brand_name: str | None = None
    brand_logo_url: str | None = None
    brand_primary_color: str | None = None
    brand_accent_color: str | None = None
    created_at: datetime
    updated_at: datetime
