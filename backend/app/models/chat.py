import uuid
from datetime import datetime, timezone
from typing import Any
from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from ..database import Base

class ChatRow(Base):
    __tablename__ = "chat_rows"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    dashboard_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False)
    source_row_index: Mapped[int] = mapped_column(Integer, nullable=False)
    raw: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    ai_sentiment: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_sentiment_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    ai_topics: Mapped[list[str]] = mapped_column(JSON, default=list)
    ai_intent: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ai_retry_count: Mapped[int] = mapped_column(Integer, default=0)
    ai_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    dashboard = relationship("Dashboard", back_populates="chat_rows")
