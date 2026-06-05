"""Per-client AI integration request/response shapes.

Security contract:
  - API key flows IN as plaintext (the admin pasted it) — backend encrypts
    it before storing.
  - API key NEVER flows OUT in plaintext. Responses include `api_key_masked`
    (e.g. "sk-…AAAA") so the admin can confirm which key is configured but
    can't read the original.
  - To rotate, the admin re-PUTs with a fresh key.
"""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


Provider = Literal["openai", "claude"]


class AIIntegrationIn(BaseModel):
    provider: Provider
    api_key: str = Field(min_length=10, description="Raw provider API key. Encrypted before storage.")
    model: str | None = Field(default=None, description="Optional model override (e.g. 'gpt-4o-mini' or 'claude-haiku-4-5').")
    is_active: bool = True

    @field_validator("api_key")
    @classmethod
    def _strip_key(cls, v: str) -> str:
        return v.strip()


class AIIntegrationOut(BaseModel):
    id: str
    client_id: str
    provider: Provider
    # Plaintext key is never returned. This is "sk-…XXXX" style for display.
    api_key_masked: str
    model: str | None
    is_active: bool
    last_used_at: datetime | None
    created_at: datetime
    updated_at: datetime


class AITestResult(BaseModel):
    """Result of POST /api/admin/clients/{id}/ai/test — fires one cheap
    label request against the configured key and reports back."""
    ok: bool
    provider: Provider
    model: str
    latency_ms: int
    error: str | None = None
    # Sample output so the admin can eyeball the model's behavior.
    sample_sentiment: str | None = None
    sample_topics: list[str] | None = None
