"""Tests for the stub /investigate endpoint (S-1.3).

Verifies the request/response wire schemas + that the canned verdict matches
the mockup data (single source of truth for Verdict Card / Timeline UI work).
"""

import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.schemas import InvestigateResponse, Verdict


@pytest.fixture
def client() -> TestClient:
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


def test_investigate_returns_canned_high_conf_remove(client: TestClient) -> None:
    r = client.post("/investigate", json=_valid_request())
    assert r.status_code == 200, r.text

    body = InvestigateResponse.model_validate(r.json())
    v: Verdict = body.data

    assert v.correlation_id == "test-correlation-001"
    assert v.tier == "DEEP"
    assert v.risk_tier == "HIGH"
    assert v.recommendation == "REMOVE"
    assert v.calibrated_confidence == 0.92
    assert "[ev-2]" in v.rationale and "[ev-4]" in v.rationale and "[ev-5]" in v.rationale
    assert v.model_reasoner == "gemini-2.5-pro"
    assert v.model_summarizer == "gemini-2.5-flash"


def test_canned_verdict_has_three_top_evidence_rows(client: TestClient) -> None:
    body = InvestigateResponse.model_validate(
        client.post("/investigate", json=_valid_request()).json()
    )
    assert len(body.data.top_evidence) == 3
    assert {row.id for row in body.data.top_evidence} == {"ev-2", "ev-4", "ev-5"}
    # Every cited evidence-id in the rationale resolves to top_evidence — citation contract sanity.
    cited_ids = {f"ev-{n}" for n in ("2", "4", "5")}
    for ev_id in cited_ids:
        assert any(row.id == ev_id for row in body.data.top_evidence)


def test_canned_verdict_timeline_matches_mockup(client: TestClient) -> None:
    body = InvestigateResponse.model_validate(
        client.post("/investigate", json=_valid_request()).json()
    )
    timeline = body.data.timeline
    assert len(timeline) == 4
    assert [step.tool for step in timeline] == [
        "policy_match",
        "report_velocity",
        "user_history",
        "thread_context",
    ]
    assert [step.verb for step in timeline] == [
        "Matched against rules",
        "Checked report velocity",
        "Pulled author history",
        "Read thread context",
    ]
    assert all(step.status == "success" for step in timeline)


def test_confidence_breakdown_in_valid_range(client: TestClient) -> None:
    body = InvestigateResponse.model_validate(
        client.post("/investigate", json=_valid_request()).json()
    )
    cb = body.data.confidence_breakdown
    for value in (
        cb.llm_self_report,
        cb.evidence_convergence,
        cb.subreddit_accuracy,
        cb.rule_match_strength,
    ):
        assert 0.0 <= value <= 1.0


def test_investigate_rejects_malformed_subreddit_id(client: TestClient) -> None:
    payload = _valid_request()
    payload["subreddit_id"] = "not_a_subreddit"  # must match `^t5_`
    r = client.post("/investigate", json=payload)
    assert r.status_code == 400
    body = r.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "BAD_REQUEST"
    assert "subreddit_id" in body["error"]["message"]


def test_investigate_rejects_missing_correlation_id(client: TestClient) -> None:
    payload = _valid_request()
    del payload["correlation_id"]
    r = client.post("/investigate", json=payload)
    assert r.status_code == 400


def test_investigate_rejects_negative_reporter_count(client: TestClient) -> None:
    payload = _valid_request()
    payload["report"] = {"reasons": [], "reporter_count": -1}
    r = client.post("/investigate", json=payload)
    assert r.status_code == 400


def test_investigate_accepts_post_target(client: TestClient) -> None:
    payload = _valid_request()
    payload["target"] = {
        "kind": "post",
        "id": "t3_1tbrryu",
        "body": "Hi all",
        "author": "t2_ewyhkkhu",
    }
    r = client.post("/investigate", json=payload)
    assert r.status_code == 200
