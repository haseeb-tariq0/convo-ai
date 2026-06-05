import uuid
import secrets
from datetime import datetime, timezone
from typing import Any
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from ..database import Base

def _now():
    return datetime.now(timezone.utc)

def _share_token():
    return secrets.token_urlsafe(24)

class Dashboard(Base):
    __tablename__ = "dashboards"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    client_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    share_token: Mapped[str] = mapped_column(Text, unique=True, default=_share_token)
    sheet_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    sheet_tab_name: Mapped[str] = mapped_column(Text, default="Sheet1")
    sheet_column_map: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)
    field_config: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    poll_interval_seconds: Mapped[int] = mapped_column(Integer, default=30)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    
    # Per-dashboard branding (from migration 0006)
    brand_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    brand_logo_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    brand_primary_color: Mapped[str | None] = mapped_column(Text, nullable=True)
    brand_accent_color: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Per-dashboard layout config (section order + visibility) — migration 0011
    layout_config: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    client = relationship("Client", back_populates="dashboards")
    chat_rows = relationship("ChatRow", back_populates="dashboard", cascade="all, delete-orphan")
    sync_logs = relationship("SyncLog", back_populates="dashboard", cascade="all, delete-orphan")
