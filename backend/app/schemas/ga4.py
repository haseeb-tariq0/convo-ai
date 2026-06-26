from datetime import datetime

from pydantic import BaseModel, Field


class GA4ConfigIn(BaseModel):
    property_id: str = Field(min_length=1)
    # Optional: blank → use the global Nexa service account (the default). Only
    # set when a client insists on their own GA4 service account.
    credentials_json: str = ""
    conversion_event_name: str = "purchase"
    lookback_days: int = Field(default=30, ge=1, le=365)
    sync_users: bool = True
    sync_pageviews: bool = True
    sync_events: bool = False
    sync_conversions: bool = True
    sync_traffic_sources: bool = True
    sync_devices: bool = True


class GA4ConfigOut(BaseModel):
    id: str
    client_id: str
    property_id: str
    conversion_event_name: str
    lookback_days: int
    sync_users: bool
    sync_pageviews: bool
    sync_events: bool
    sync_conversions: bool
    sync_traffic_sources: bool
    sync_devices: bool
    last_synced_at: datetime | None
    # NB: credentials_json is intentionally NOT exposed in the response.
