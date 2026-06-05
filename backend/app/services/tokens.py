"""Share-token generation + lookup. Trivial today; lives in its own module so
the hashing / rotation policy can evolve without touching routers."""
import secrets


def new_share_token() -> str:
    # SPEC §10: secrets.token_urlsafe(24) → 32 url-safe chars.
    return secrets.token_urlsafe(24)
