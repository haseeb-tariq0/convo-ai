"""AI processing — turns raw chat messages into sentiment / topics / intent.

Two modes, picked from settings:
1. Mock (USE_MOCK_AI=true) — deterministic heuristic so the pipeline runs
   end-to-end with no API key. Lets us seed + demo the dashboard.
2. Real — calls Claude haiku-4.5 (SPEC §9). Implemented but untested against
   the live API; flipping the flag in prod still needs a smoke test.

SPEC §9 hard rule: batch up to 20 messages per call. Never one-per-row.
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from ..config import get_settings
from ..store import ChatRow, store
from . import encryption

log = logging.getLogger(__name__)

BATCH_SIZE = 20
MAX_PER_TICK = 50  # SPEC §8: up to 50 rows per AI tick.


# --- mock implementation ----------------------------------------------------

_POSITIVE_KEYWORDS = {
    "thanks", "thank you", "great", "perfect", "amazing", "love", "excellent",
    "happy", "good", "appreciate", "wonderful", "شكرا", "ممتاز",
}
_NEGATIVE_KEYWORDS = {
    "bad", "terrible", "awful", "angry", "broken", "slow",
    "rude", "disappointed", "wrong", "never", "refund", "سيء", "غاضب",
}
_QUESTION_TRIGGERS = {"?", "how", "what", "when", "where", "why", "can you", "could you"}
_REQUEST_TRIGGERS = {"please", "i need", "i want", "i'd like", "send me"}
# Bucket triggers — chosen to mirror the Rove Looker Studio dashboard's
# "Nature of Chat" pie (Sales / Business Opportunity · Customer Services ·
# Complaint · Other). Order matters: sales wins over service over complaint.
_SALES_KEYWORDS = {
    "book", "booking", "reserve", "reservation", "availability", "price",
    "rate", "cost", "how much", "per night", "check in", "check-in", "stay",
    "rooms available", "احجز", "حجز", "سعر",
}
_SERVICE_KEYWORDS = {
    "breakfast", "wifi", "wi-fi", "parking", "checkout", "check out",
    "check-out", "amenities", "room service", "spa", "pool", "gym", "menu",
    "address", "location", "directions", "shuttle", "transport", "taxi",
    "early check", "late check", "luggage", "laundry", "iron", "towels",
    "إفطار", "موقع",
}
_COMPLAINT_KEYWORDS = {
    "complaint", "complain", "issue", "problem", "broken", "not working",
    "doesn't work", "terrible", "awful", "disappointed", "rude", "refund",
    "مشكلة", "شكوى",
}


def _mock_label(message: str) -> dict[str, Any]:
    text = (message or "").lower()
    pos = sum(1 for w in _POSITIVE_KEYWORDS if w in text)
    neg = sum(1 for w in _NEGATIVE_KEYWORDS if w in text)
    score = max(-1.0, min(1.0, (pos - neg) / 3.0))
    if score > 0.2:
        sentiment = "positive"
    elif score < -0.2:
        sentiment = "negative"
    else:
        sentiment = "neutral"
    # Priority order matches Rove's labels: a booking question is "sales"
    # not "service"; a service question with a complaint word is "complaint".
    if any(k in text for k in _COMPLAINT_KEYWORDS):
        intent = "complaint"
    elif any(k in text for k in _SALES_KEYWORDS):
        intent = "sales"
    elif any(k in text for k in _SERVICE_KEYWORDS):
        intent = "service"
    elif any(t in text for t in _REQUEST_TRIGGERS):
        intent = "request"
    elif any(t in text for t in _QUESTION_TRIGGERS):
        intent = "question"
    elif sentiment == "positive":
        intent = "praise"
    elif sentiment == "negative":
        intent = "complaint"
    else:
        intent = "other"

    # Topics — pull a few content words as a stand-in for the real topic
    # extraction Claude will do.
    stopwords = {"the", "a", "an", "and", "or", "but", "to", "of", "for", "in",
                 "on", "is", "are", "i", "you", "we", "it", "this", "that",
                 "my", "your", "with", "at", "be", "have", "do"}
    words = re.findall(r"[a-zA-Z؀-ۿ]{4,}", text)
    topics_seen: list[str] = []
    for w in words:
        if w in stopwords or w in topics_seen:
            continue
        topics_seen.append(w)
        if len(topics_seen) >= 3:
            break
    if not topics_seen:
        topics_seen = ["general"]
    return {"sentiment": sentiment, "sentiment_score": score, "topics": topics_seen, "intent": intent}


# --- real Claude call (kept as a stub until anthropic SDK is installed) -----

# Prompt is provider-neutral. The "JSON" mention is required by OpenAI's
# JSON-object response_format mode; Claude ignores it harmlessly.
_PROMPT = """You will receive a JSON array of hotel-guest chat messages. For each input message return one JSON object with:
- index: integer matching the input position (0-based)
- sentiment: "positive" | "neutral" | "negative"
- sentiment_score: float from -1.0 (very negative) to 1.0 (very positive)
- topics: array of 1-5 short topic tags (lowercase, hyphenated, no spaces)
- intent: one of:
    "sales"      — booking, reservation, pricing, room availability, "I want to book"
    "service"    — service questions (breakfast, wifi, parking, checkout, room service, etc.)
    "complaint"  — explicit complaint or strongly negative experience
    "question"   — generic question that doesn't fit sales/service/complaint
    "request"    — non-sales action request (call back, send link, etc.)
    "praise"     — positive feedback or thank-you
    "other"      — greeting, unclear, or off-topic

Return a JSON object of the shape `{{"results": [...]}}` containing the array of analyses in input order. No prose, no markdown. Messages may be in English, Arabic, Hindi, French, or mixed.

Messages:
{messages}
"""


def _unwrap_results(parsed: Any, batch_size: int) -> list[dict[str, Any]]:
    """Normalize the model's reply to a list. OpenAI's JSON mode forces a
    top-level object, so we look for common wrapper keys; Claude usually
    returns a bare array. Either way, return a list[dict]."""
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        for key in ("results", "items", "messages", "analyses", "data"):
            value = parsed.get(key)
            if isinstance(value, list):
                return value
        # Single-message batch returning a single object is also OK.
        if batch_size == 1:
            return [parsed]
    raise ValueError(f"Model returned unparseable shape: {type(parsed).__name__}")


def _resolve_credentials(client_id: str | None) -> tuple[str, str, str, str | None]:
    """Return `(provider, api_key, model, integration_id)` for a client.

    Lookup order:
      1. Per-client integration in `ai_integrations` (if `client_id` given
         and a row exists). Decrypts the stored Fernet ciphertext.
      2. Platform defaults from .env (`AI_PROVIDER`, `OPENAI_API_KEY`,
         `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`).

    `integration_id` is None when the platform default was used, so
    `touch_ai_last_used` can be skipped on those calls.
    """
    settings = get_settings()
    if client_id:
        integration = store.get_ai_for_client(client_id)
        if integration and integration.is_active:
            try:
                api_key = encryption.decrypt(integration.api_key_encrypted)
            except ValueError as e:
                # Per-client key exists but can't be decrypted (rotated
                # master key, corrupted ciphertext). Surface clearly
                # instead of silently falling back — the admin needs to
                # re-paste the key.
                raise RuntimeError(
                    f"client {client_id}'s AI key failed to decrypt: {e}"
                ) from e
            provider = integration.provider.lower().strip()
            # Per-client model override; else the platform default for
            # that provider.
            if integration.model:
                model = integration.model
            elif provider in ("claude", "anthropic"):
                model = settings.anthropic_model
            else:
                model = settings.openai_model
            return provider, api_key, model, integration.id

    # Platform fallback.
    provider = settings.ai_provider.lower().strip()
    if provider in ("claude", "anthropic"):
        if not settings.anthropic_api_key:
            raise RuntimeError("no per-client AI key + ANTHROPIC_API_KEY not set")
        return "claude", settings.anthropic_api_key, settings.anthropic_model, None
    if not settings.openai_api_key:
        raise RuntimeError("no per-client AI key + OPENAI_API_KEY not set")
    return "openai", settings.openai_api_key, settings.openai_model, None


def _call_openai_batched(messages: list[str], api_key: str, model: str) -> list[dict[str, Any]]:
    try:
        from openai import OpenAI  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "openai SDK not installed — `pip install openai>=1.30` or "
            "re-run `pip install -e .` after the dependency was added."
        ) from e

    client = OpenAI(api_key=api_key)
    prompt = _PROMPT.format(messages=json.dumps(messages, ensure_ascii=False))
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
        max_tokens=2000,
        response_format={"type": "json_object"},
    )
    raw = resp.choices[0].message.content or ""
    parsed = json.loads(raw)
    return _unwrap_results(parsed, len(messages))


def _call_claude_batched(messages: list[str], api_key: str, model: str) -> list[dict[str, Any]]:
    try:
        from anthropic import Anthropic  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "anthropic SDK not installed — re-run `pip install -e .` "
            "after the dependency was added."
        ) from e

    client = Anthropic(api_key=api_key)
    prompt = _PROMPT.format(messages=json.dumps(messages, ensure_ascii=False))
    resp = client.messages.create(
        model=model,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = resp.content[0].text  # type: ignore[attr-defined]
    parsed = json.loads(raw)
    return _unwrap_results(parsed, len(messages))


def _real_label_batch(messages: list[str], client_id: str | None = None) -> list[dict[str, Any]]:
    """Call the configured provider with the right key for this client.

    Per-client integration wins over the platform .env defaults. Bumps
    `last_used_at` on the integration after a successful call so the
    admin UI can show 'last used N minutes ago'.
    """
    provider, api_key, model, integration_id = _resolve_credentials(client_id)
    if provider == "openai":
        results = _call_openai_batched(messages, api_key, model)
    elif provider in ("claude", "anthropic"):
        results = _call_claude_batched(messages, api_key, model)
    else:
        raise ValueError(
            f"Unknown AI provider {provider!r}. Expected one of: openai, claude."
        )
    if integration_id:
        try:
            store.touch_ai_last_used(integration_id)
        except Exception as e:  # noqa: BLE001 — best-effort book-keeping
            log.debug("touch_ai_last_used failed for %s: %s", integration_id, e)
    return results


def label_messages_for_client(client_id: str, messages: list[str]) -> list[dict[str, Any]]:
    """Public helper used by `routers/admin_ai.py` to smoke-test a client's
    configured key. Bypasses the mock path so the test actually exercises
    the real provider."""
    return _real_label_batch(messages, client_id=client_id)


# --- public entrypoint (called by scheduler) --------------------------------

def _client_id_for_dashboard(dashboard_id: str, cache: dict[str, str | None]) -> str | None:
    """Resolve a row's client_id by looking up its dashboard. Caches per
    process_pending_rows call so we don't hammer the store with one
    lookup per row."""
    if dashboard_id in cache:
        return cache[dashboard_id]
    d = store.get_dashboard(dashboard_id)
    cid = d.client_id if d else None
    cache[dashboard_id] = cid
    return cid


def process_pending_rows() -> None:
    """Pull up to MAX_PER_TICK unprocessed rows, batch them through the
    configured provider per CLIENT (so each client's bill stays on their
    own key), mark them processed in a single bulk update.

    Grouping by client matters because different clients can have
    different OpenAI / Anthropic keys. Within a client, we still chunk
    to BATCH_SIZE messages per API call to stay under context limits.

    On any error: log to sync_logs and leave ai_processed_at NULL so the
    next tick retries (capped at 3 attempts per row by the retry-count
    column).
    """
    rows = store.unprocessed_chat_rows(limit=MAX_PER_TICK)
    if not rows:
        return
    settings = get_settings()
    start = time.monotonic()
    updates: list[dict] = []
    try:
        from datetime import datetime, timezone
        now_iso = datetime.now(timezone.utc).isoformat()

        # Group rows by client_id so each client's API key is used for
        # their own messages. Dashboards within a client share the
        # client's key (one billing relationship per client). Rows with
        # no resolvable client (orphaned / deleted dashboard) fall into
        # the None bucket and use the platform default key.
        dash_to_client: dict[str, str | None] = {}
        by_client: dict[str | None, list[ChatRow]] = {}
        for r in rows:
            cid = _client_id_for_dashboard(r.dashboard_id, dash_to_client)
            by_client.setdefault(cid, []).append(r)

        for client_id, client_rows in by_client.items():
            for batch_start in range(0, len(client_rows), BATCH_SIZE):
                batch = client_rows[batch_start : batch_start + BATCH_SIZE]
                # Real data uses "Content"; older fixtures used "Message".
                # Check both keys + their lowercase variants so this works
                # across both.
                messages = [
                    (
                        r.raw.get("Content")
                        or r.raw.get("content")
                        or r.raw.get("Message")
                        or r.raw.get("message")
                        or ""
                    )
                    for r in batch
                ]
                if settings.use_mock_ai:
                    results = [_mock_label(m) for m in messages]
                else:
                    try:
                        results = _real_label_batch(messages, client_id=client_id)
                    except Exception as e:
                        log.warning(
                            "batch AI processing failed (client=%s): %s", client_id, e,
                        )
                        store.bulk_increment_retry_count([r.id for r in batch], str(e))
                        continue

                for row, result in zip(batch, results):
                    updates.append(
                        {
                            "id": row.id,
                            "ai_sentiment": result.get("sentiment"),
                            "ai_sentiment_score": result.get("sentiment_score"),
                            "ai_topics": result.get("topics", []) or [],
                            "ai_intent": result.get("intent"),
                            "ai_processed_at": now_iso,
                            "ai_error": None,
                        }
                    )
        store.bulk_mark_chat_rows_processed(updates)
        store.log_sync(
            source="ai",
            status="success",
            message=f"processed {len(updates)} rows",
            rows_processed=len(updates),
            duration_ms=int((time.monotonic() - start) * 1000),
        )
    except Exception as e:  # noqa: BLE001 — top-level scheduler tick
        log.exception("ai processing failed")
        store.log_sync(
            source="ai",
            status="error",
            message=f"{type(e).__name__}: {e}",
            rows_processed=len(updates),
            duration_ms=int((time.monotonic() - start) * 1000),
        )
