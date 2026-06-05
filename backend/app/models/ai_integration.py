"""Per-client AI provider integration. Mirrors GA4Integration: one row per
client, owns the encrypted API key + chosen provider/model.

When `process_pending_rows()` runs, it groups unprocessed rows by dashboard
→ client, looks up the integration here, and dispatches the OpenAI/Claude
call with the client-specific key. Falls back to the platform .env key
when no integration exists.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class AIIntegration(Base):
    __tablename__ = "ai_integrations"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    client_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"),
        unique=True,  # one integration per client
        nullable=False,
    )
    # 'openai' | 'claude' — kept as plain text for forward-compat.
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    # Fernet ciphertext via services.encryption. Never stored plaintext.
    api_key_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    # Optional model override; NULL = use platform default for this provider.
    model: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False,
    )

    client = relationship("Client", back_populates="ai_integration")
