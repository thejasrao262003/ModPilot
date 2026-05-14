"""Tests for the /investigate endpoint (E-2.11).

Verifies the request/response wire schemas, validation, and that the
endpoint calls the pipeline and returns the verdict.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock, patch

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.pipeline import PipelineResult
from api.schemas import (
    ConfidenceBreakdown,
    EvidenceRow,
    InvestigateResponse,
    TimelineStep,
    Verdict,
)
from orchestrator.tools import EvidenceAccumulator, ToolResult


def _fake_accumulator() -> EvidenceAccumulator:
    acc = EvidenceAccumulator()
    acc.append(
        ToolResult(
            tool="policy_match",
            status="success",
            summary="matched rule 2",
            latency_ms=10,
            detail={},
        )
    )
    return acc


def _fake_verdict(correlation_id: str = "test-correlation-001") -> Verdict:
    return Verdict(
        correlation_id=correlation_id,
        tier="STANDARD",
        risk_tier="HIGH",
        recommendation="REMOVE",
        calibrated_confidence=0.82,
        rationale="The content matches rule 2 with high confidence [ev-1].",
        top_evidence=[
            EvidenceRow(id="ev-1", summary="matched rule 2", tool="policy_match"),
        ],
        timeline=[
            TimelineStep(
                tool="policy_match",
                verb="Matched against rules",
                status="success",
                latency_ms=10,
                evidence_ids=["ev-1"],
            ),
        ],
        confidence_breakdown=ConfidenceBreakdown(
            llm_self_report=0.88,
            evidence_convergence=0.75,
            subreddit_accuracy=0.5,
            rule_match_strength=0.91,
        ),
        model_reasoner="gemini-2.5-pro",
        model_summarizer="",
        cost_usd=0.002,
        latency_ms=1500,
        validation_flag=False,
        degraded=False,
        cold_start=True,
    )


def _fake_pipeline_result(
    correlation_id: str = "test-correlation-001",
) -> PipelineResult:
    return PipelineResult(
        verdict=_fake_verdict(correlation_id),
        accumulator=_fake_accumulator(),
        tier="STANDARD",
        input_tokens=500,
        output_tokens=120,
        cost_usd=0.002,
        model_reasoner="gemini-2.5-pro",
        validation_flag=False,
        cold_start=True,
    )


@asynccontextmanager
async def _mock_session(_factory: object = None) -> AsyncIterator[MagicMock]:
    """Yield a mock session that returns None for get_subreddit_profile."""
    yield MagicMock()


@pytest.fixture
def client() -> TestClient:
    """TestClient with app.state populated to satisfy endpoint reads."""
    # Set state attributes that the endpoint reads before calling the pipeline.
    app.state.orchestrator = MagicMock()
    app.state.llm = MagicMock()
    app.state.pg_sessions = MagicMock()
    return TestClient(app)


def _valid_request() -> dict[str, object]:
    return {
        "correlation_id": "test-correlation-001",
        "subreddit_id": "t5_hu2lax",
        "target": {
            "kind": "comment",
            "id": "t1_kx9m2af",
            "body": "example body",
            "author": "t2_ewyhkkhu",
        },
        "report": {
            "reasons": ["This content is impersonation"],
            "reporter_count": 4,
        },
        "context": {"thread_id": "t3_xxx", "thread_excerpts": []},
    }


class TestInvestigateEndpoint:
    def test_returns_200_with_verdict(self, client: TestClient) -> None:
        mock_pipeline = AsyncMock(return_value=_fake_pipeline_result())
        with (
            patch("api.main.run_investigation", mock_pipeline),
            patch("api.main._persist", new_callable=AsyncMock),
            patch("api.main.with_session", _mock_session),
            patch("api.main.ensure_subreddit_profile", new_callable=AsyncMock, return_value=None),
            patch("api.main.get_user_memory", new_callable=AsyncMock, return_value=None),
            patch("api.main.get_thread_memory", new_callable=AsyncMock, return_value=None),
        ):
            r = client.post("/investigate", json=_valid_request())
        assert r.status_code == 200
        body = InvestigateResponse.model_validate(r.json())
        assert body.data.correlation_id == "test-correlation-001"
        assert body.data.recommendation == "REMOVE"

    def test_verdict_fields_propagated(self, client: TestClient) -> None:
        mock_pipeline = AsyncMock(return_value=_fake_pipeline_result())
        with (
            patch("api.main.run_investigation", mock_pipeline),
            patch("api.main._persist", new_callable=AsyncMock),
            patch("api.main.with_session", _mock_session),
            patch("api.main.ensure_subreddit_profile", new_callable=AsyncMock, return_value=None),
            patch("api.main.get_user_memory", new_callable=AsyncMock, return_value=None),
            patch("api.main.get_thread_memory", new_callable=AsyncMock, return_value=None),
        ):
            r = client.post("/investigate", json=_valid_request())
        v = InvestigateResponse.model_validate(r.json()).data
        assert v.tier == "STANDARD"
        assert v.risk_tier == "HIGH"
        assert v.calibrated_confidence == 0.82
        assert v.model_reasoner == "gemini-2.5-pro"

    def test_pipeline_called_with_request(self, client: TestClient) -> None:
        mock_pipeline = AsyncMock(return_value=_fake_pipeline_result())
        with (
            patch("api.main.run_investigation", mock_pipeline),
            patch("api.main._persist", new_callable=AsyncMock),
            patch("api.main.with_session", _mock_session),
            patch("api.main.ensure_subreddit_profile", new_callable=AsyncMock, return_value=None),
            patch("api.main.get_user_memory", new_callable=AsyncMock, return_value=None),
            patch("api.main.get_thread_memory", new_callable=AsyncMock, return_value=None),
        ):
            client.post("/investigate", json=_valid_request())
        mock_pipeline.assert_called_once()
        call_kwargs = mock_pipeline.call_args.kwargs
        assert call_kwargs["req"].correlation_id == "test-correlation-001"
        assert call_kwargs["personality"] == "balanced"  # default cold-start

    def test_persist_called(self, client: TestClient) -> None:
        mock_pipeline = AsyncMock(return_value=_fake_pipeline_result())
        mock_persist = AsyncMock()
        with (
            patch("api.main.run_investigation", mock_pipeline),
            patch("api.main._persist", mock_persist),
            patch("api.main.with_session", _mock_session),
            patch("api.main.ensure_subreddit_profile", new_callable=AsyncMock, return_value=None),
            patch("api.main.get_user_memory", new_callable=AsyncMock, return_value=None),
            patch("api.main.get_thread_memory", new_callable=AsyncMock, return_value=None),
        ):
            client.post("/investigate", json=_valid_request())
        mock_persist.assert_called_once()


class TestInvestigateValidation:
    def test_rejects_malformed_subreddit_id(self, client: TestClient) -> None:
        payload = _valid_request()
        payload["subreddit_id"] = "not_a_subreddit"
        r = client.post("/investigate", json=payload)
        assert r.status_code == 400
        body = r.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "BAD_REQUEST"
        assert "subreddit_id" in body["error"]["message"]

    def test_rejects_missing_correlation_id(self, client: TestClient) -> None:
        payload = _valid_request()
        del payload["correlation_id"]
        r = client.post("/investigate", json=payload)
        assert r.status_code == 400

    def test_rejects_negative_reporter_count(self, client: TestClient) -> None:
        payload = _valid_request()
        payload["report"] = {"reasons": [], "reporter_count": -1}
        r = client.post("/investigate", json=payload)
        assert r.status_code == 400

    def test_accepts_post_target(self, client: TestClient) -> None:
        mock_pipeline = AsyncMock(return_value=_fake_pipeline_result())
        with (
            patch("api.main.run_investigation", mock_pipeline),
            patch("api.main._persist", new_callable=AsyncMock),
            patch("api.main.with_session", _mock_session),
            patch("api.main.ensure_subreddit_profile", new_callable=AsyncMock, return_value=None),
            patch("api.main.get_user_memory", new_callable=AsyncMock, return_value=None),
            patch("api.main.get_thread_memory", new_callable=AsyncMock, return_value=None),
        ):
            payload = _valid_request()
            payload["target"] = {
                "kind": "post",
                "id": "t3_1tbrryu",
                "body": "Hi all",
                "author": "t2_ewyhkkhu",
            }
            r = client.post("/investigate", json=payload)
        assert r.status_code == 200
