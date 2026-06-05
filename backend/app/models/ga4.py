import uuid
from datetime import datetime, timezone, date
from typing import Any
from sqlalchemy import Boolean, DateTime, Date, ForeignKey, Integer, String, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from ..database import Base

def _now():
    return datetime.now(timezone.utc)

class GA4Integration(Base):
    __tablename__ = "ga4_integrations"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    client_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), unique=True, nullable=False)
    property_id: Mapped[str] = mapped_column(Text, nullable=False)
    credentials_json: Mapped[str] = mapped_column(Text, nullable=False)
    conversion_event_name: Mapped[str] = mapped_column(Text, default="purchase")
    lookback_days: Mapped[int] = mapped_column(Integer, default=30)
    sync_users: Mapped[bool] = mapped_column(Boolean, default=True)
    sync_pageviews: Mapped[bool] = mapped_column(Boolean, default=True)
    sync_events: Mapped[bool] = mapped_column(Boolean, default=False)
    sync_conversions: Mapped[bool] = mapped_column(Boolean, default=True)
    sync_traffic_sources: Mapped[bool] = mapped_column(Boolean, default=True)
    sync_devices: Mapped[bool] = mapped_column(Boolean, default=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    client = relationship("Client", back_populates="ga4_integration")
    snapshots = relationship("GA4Snapshot", back_populates="integration", cascade="all, delete-orphan")
    sync_logs = relationship("SyncLog", back_populates="ga4_integration", cascade="all, delete-orphan")

class GA4Snapshot(Base):
    __tablename__ = "ga4_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    ga4_integration_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("ga4_integrations.id", ondelete="CASCADE"), nullable=False)
    metric_type: Mapped[str] = mapped_column(Text, nullable=False)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)

    integration = relationship("GA4Integration", back_populates="snapshots")
