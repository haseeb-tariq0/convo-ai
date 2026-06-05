import uuid
from datetime import datetime, timezone
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from ..database import Base

def _now():
    return datetime.now(timezone.utc)

class SyncLog(Base):
    __tablename__ = "sync_logs"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    dashboard_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("dashboards.id", ondelete="SET NULL"), nullable=True)
    ga4_integration_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("ga4_integrations.id", ondelete="SET NULL"), nullable=True)
    source: Mapped[str] = mapped_column(Text, nullable=False)    # sheets | ga4 | ai
    status: Mapped[str] = mapped_column(Text, nullable=False)    # success | error
    message: Mapped[str] = mapped_column(Text, default="")
    rows_processed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    dashboard = relationship("Dashboard", back_populates="sync_logs")
    ga4_integration = relationship("GA4Integration", back_populates="sync_logs")
