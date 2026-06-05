"""Symmetric encryption for at-rest third-party credentials.

Wraps cryptography.fernet so callers don't import the crypto library
directly. Used by `_AIIntegration.api_key_encrypted` (and any future
secret-at-rest column, e.g. GA4 credentials when we land §14 phase 5).

The master key comes from `ENCRYPTION_KEY` in settings — a URL-safe
base64-encoded 32-byte secret, the format Fernet expects. Generate one
with:

    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

If the key is missing in development we fall back to a stable derived
key so the in-memory store can still round-trip values, but a warning
is logged loudly because that key is NOT a real secret. In production
the app refuses to start if ENCRYPTION_KEY is missing.
"""
from __future__ import annotations

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

from ..config import get_settings

log = logging.getLogger(__name__)

_FALLBACK_DEV_SEED = b"convo-ai-dev-encryption-fallback-do-not-use-in-prod"


def _fernet() -> Fernet:
    s = get_settings()
    key = (s.encryption_key or "").strip()
    if not key:
        if s.app_env == "production":
            raise RuntimeError(
                "ENCRYPTION_KEY is required in production. Generate one with "
                "`python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'` "
                "and set it in .env."
            )
        # Dev fallback — derive a deterministic key so the in-memory store
        # can roundtrip values across restarts within a single dev session.
        # NEVER use this in production; log loudly each call so we can't
        # ship by accident.
        log.warning(
            "ENCRYPTION_KEY not set — using DEV FALLBACK key. "
            "Set ENCRYPTION_KEY in .env before deploying."
        )
        derived = hashlib.sha256(_FALLBACK_DEV_SEED).digest()
        key = base64.urlsafe_b64encode(derived).decode()
    return Fernet(key.encode())


def encrypt(plaintext: str) -> str:
    """Encrypt a UTF-8 string. Returns the Fernet token as a string. The
    token includes a timestamp, so two encryptions of the same value
    return different ciphertexts — that's by design."""
    if not plaintext:
        raise ValueError("cannot encrypt empty string")
    token = _fernet().encrypt(plaintext.encode("utf-8"))
    return token.decode("ascii")


def decrypt(token: str) -> str:
    """Decrypt a Fernet token. Raises ValueError if the ciphertext is
    invalid (wrong key, tampered, etc.). Callers should catch and either
    refuse the operation or surface a clear "decryption failed" error."""
    if not token:
        raise ValueError("cannot decrypt empty token")
    try:
        plain = _fernet().decrypt(token.encode("ascii"))
    except InvalidToken as e:
        raise ValueError(
            "decryption failed — wrong ENCRYPTION_KEY, or ciphertext tampered/corrupted"
        ) from e
    return plain.decode("utf-8")


def decrypt_or_passthrough(value: str) -> str:
    """For columns that have a mix of pre-encryption plaintext rows and
    post-encryption Fernet tokens. Heuristic: Fernet tokens start with
    `gAAAA` (URL-safe base64 of the token's header bytes). Anything else
    is treated as legacy plaintext and returned unchanged.

    Used by GA4 credentials_json which carries a JSON document — a real
    payload always starts with `{`, never `gAAAA`. Lets us flip the
    encrypt switch without a one-off rewrite migration.
    """
    if not value:
        return value
    if value.startswith("gAAAA"):
        return decrypt(value)
    return value


def mask(value: str, keep: int = 4) -> str:
    """Return a key suitable for display in the admin UI: shows the prefix
    + last `keep` chars, rest replaced with dots. Mirrors how OpenAI's own
    dashboard renders keys (`sk-...AAAA`). Used by GET responses so the
    plaintext never leaves the backend."""
    if not value:
        return ""
    if len(value) <= keep + 6:
        return "•" * len(value)
    # Take the provider prefix (`sk-`, `sk-proj-`, `sk-ant-`) and the tail.
    head = value[:7] if value.startswith("sk-proj-") else value[:3]
    return f"{head}…{value[-keep:]}"
