"""Test fixtures.

The default Settings instance is cached via @lru_cache, and the store is a
lazy module-level singleton. We force both into a known state before each
test: USE_IN_MEMORY_STORE=true so we never accidentally hit live Supabase
from CI, and a fresh _InMemoryStore so tests are hermetic.
"""
from __future__ import annotations

import os

import pytest

# Set the env var BEFORE importing app modules so the cached Settings picks
# it up on first read. Without this, the test process inherits whatever the
# developer has in .env.
os.environ["USE_IN_MEMORY_STORE"] = "true"
os.environ.setdefault("ADMIN_TOKEN", "test-admin-token")
# Reset the cached Settings just in case it was already built by something
# else in the test session (e.g. pytest's collection phase).
from app.config import get_settings  # noqa: E402

get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _reset_store():
    """Wipe the in-memory store before every test."""
    from app import store as store_module

    store_module.store.reset()
    yield
    store_module.store.reset()
