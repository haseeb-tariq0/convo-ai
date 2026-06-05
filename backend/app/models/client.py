import uuid
from datetime import datetime, timezone
from sqlalchemy import Boolean, DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from ..database import Base

def _now():
    return datetime.now(timezone.utc)

class Client(Base):
    __tablename__ = "clients"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    contact_email: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Client-level branding defaults. Per-dashboard brand_* columns override.
    brand_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    brand_logo_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    brand_primary_color: Mapped[str | None] = mapped_column(Text, nullable=True)
    brand_accent_color: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    dashboards = relationship("Dashboard", back_populates="client", cascade="all, delete-orphan")
    ga4_integration = relationship("GA4Integration", back_populates="client", uselist=False, cascade="all, delete-orphan")
    ai_integration = relationship("AIIntegration", back_populates="client", uselist=False, cascade="all, delete-orphan")
