"""Tests for the engine FastAPI skeleton (F-0.5).

Covers: /health envelope, error handlers, HMAC permissive/strict modes,
correlation-id roundtrip.
"""

import hmac
import time
from collections.abc import Iterator
from hashlib import sha256

import pytest
from fastapi.testclient import TestClient

from api.config import Settings, get_settings
from api.errors import EngineError
from api.main import app
from api.middleware import HEADER_CORRELATION, HEADER_SIGNATURE, HEADER_TIMESTAMP


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def prod_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """Client with HMAC strictly enforced — production-like config."""
    get_settings.cache_clear()
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("ENGINE_SHARED_SECRET", "test-secret")
    try:
        yield TestClient(app)
    finally:
        get_settings.cache_clear()


def test_health_returns_ok_envelope(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["data"]["engine"] == "0.0.1"
    assert body["data"]["model_reasoner"] == "gemini-2.5-pro"
    assert body["data"]["model_summarizer"] == "gemini-2.5-flash"


def test_correlation_id_roundtrip_when_provided(client: TestClient) -> None:
    cid = "test-correlation-12345"
    r = client.get("/health", headers={HEADER_CORRELATION: cid})
    assert r.headers[HEADER_CORRELATION] == cid


def test_correlation_id_generated_when_absent(client: TestClient) -> None:
    r = client.get("/health")
    assert HEADER_CORRELATION in r.headers
    assert len(r.headers[HEADER_CORRELATION]) > 0


def test_hmac_permissive_in_dev(client: TestClient) -> None:
    # Dev mode: no signature header required; request passes.
    # /health is in the public path set anyway, but proves the middleware doesn't crash.
    assert client.get("/health").status_code == 200


def test_hmac_strict_rejects_missing_signature(prod_client: TestClient) -> None:
    # /health is still public — use a non-existent path to exercise middleware.
    r = prod_client.post("/feedback", json={"foo": "bar"})
    # 401 from HMAC middleware (UNAUTHORIZED envelope) takes precedence over 404.
    assert r.status_code == 401
    body = r.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "UNAUTHORIZED"
    assert body["error"]["retryable"] is False


def test_hmac_strict_accepts_valid_signature(prod_client: TestClient) -> None:
    secret = "test-secret"
    body = b'{"hello":"world"}'
    timestamp = str(int(time.time()))
    signature = hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}.".encode() + body,
        sha256,
    ).hexdigest()

    r = prod_client.post(
        "/feedback",
        content=body,
        headers={
            HEADER_SIGNATURE: signature,
            HEADER_TIMESTAMP: timestamp,
            "content-type": "application/json",
        },
    )
    # Signature passes; downstream 404 because the route doesn't exist yet.
    assert r.status_code == 404


def test_hmac_strict_rejects_skewed_timestamp(prod_client: TestClient) -> None:
    secret = "test-secret"
    body = b"{}"
    # 10 minutes in the future — past the 5-minute skew window.
    timestamp = str(int(time.time()) + 600)
    signature = hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}.".encode() + body,
        sha256,
    ).hexdigest()

    r = prod_client.post(
        "/feedback",
        content=body,
        headers={HEADER_SIGNATURE: signature, HEADER_TIMESTAMP: timestamp},
    )
    assert r.status_code == 401
    assert "skew" in r.json()["error"]["message"]


def test_engine_error_renders_envelope(client: TestClient) -> None:
    @app.get("/_test_rate_limited")
    async def _boom() -> None:
        raise EngineError("RATE_LIMITED", "test-only")

    r = client.get("/_test_rate_limited")
    assert r.status_code == 429
    body = r.json()
    assert body == {
        "ok": False,
        "error": {"code": "RATE_LIMITED", "message": "test-only", "retryable": True},
    }


def test_settings_dev_mode_default() -> None:
    get_settings.cache_clear()
    s = Settings(_env_file=None)
    assert s.is_dev is True
    assert s.hmac_enforced is False
    get_settings.cache_clear()
