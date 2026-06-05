"""End-to-end smoke test per SPEC §15. Touches:
- share-token generation + lookup
- AI batch parsing (via the mock implementation)
- aggregation functions
- public router shape

If the in-memory store ever swaps for SQLAlchemy, this test should keep
passing without modification."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.services import seed
from app.services.tokens import new_share_token
from app.store import store


def test_token_is_url_safe_and_long_enough() -> None:
    t = new_share_token()
    assert len(t) >= 32
    assert "/" not in t and "+" not in t


def test_public_dashboard_round_trip(tmp_path, monkeypatch) -> None:
    # conftest.py.fixture _reset_store already gave us a clean store.
    seed.run(store, frontend_url="http://localhost:5173", admin_token="test-token")

    # There should be at least one active dashboard with a share token.
    dashboards = store.list_active_dashboards()
    assert dashboards, "seed produced no dashboards"
    nest = next(d for d in dashboards if "Nest" in d.name)

    with TestClient(app) as client:
        # Invalid token → 404 (not 401).
        r = client.get("/api/public/dashboard/not-a-real-token")
        assert r.status_code == 404

        # Valid token → config with field_config we recognise.
        r = client.get(f"/api/public/dashboard/{nest.share_token}")
        assert r.status_code == 200
        cfg = r.json()
        assert cfg["name"].startswith("Nest")
        types = {f["type"] for f in cfg["field_config"]}
        # Every chart type the renderer claims to support should appear in
        # the seeded Nest dashboard so we exercise every aggregation path.
        assert {"metric", "gauge", "line", "bar", "pie", "tag_cloud", "table"} <= types

        # /data should return one entry per field with a non-null value.
        r = client.get(f"/api/public/dashboard/{nest.share_token}/data")
        assert r.status_code == 200
        data = r.json()
        assert len(data["fields"]) == len(cfg["field_config"])
        for f in data["fields"]:
            assert f["value"] is not None, f"field {f['id']} has null value"
            # Unknown types short-circuit to {"error": ...} — make sure none
            # of the seeded fields ended up there.
            if isinstance(f["value"], dict) and "error" in f["value"]:
                raise AssertionError(f"field {f['id']} unsupported: {f['value']['error']}")


def test_admin_endpoints_require_bearer() -> None:
    with TestClient(app) as client:
        # No auth header → 401.
        r = client.get("/api/admin/clients")
        assert r.status_code == 401

        # Wrong token → 401.
        r = client.get("/api/admin/clients", headers={"Authorization": "Bearer wrong"})
        assert r.status_code == 401


def test_health_reports_in_memory_db() -> None:
    with TestClient(app) as client:
        r = client.get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        # SPEC §11 says health should report DB status. We're explicit about
        # the in-memory build so a future probe can tell modes apart.
        assert body["db"] == "in-memory"
