"""ModPilot Investigation Engine — FastAPI entry point.

Spec: docs/Specs.md §10, docs/08-API.md
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from fastapi import FastAPI, Request

from api.config import get_settings
from api.errors import register_error_handlers
from api.middleware import CorrelationIdMiddleware, HmacMiddleware
from api.pipeline import PipelineResult, run_investigation
from api.schemas import InvestigateRequest, InvestigateResponse
from observability.logging import configure_logging, get_logger
from orchestrator.loop import Orchestrator
from orchestrator.report_velocity import ReportVelocityTool
from orchestrator.tools import ToolRegistry
from store.connections import close_postgres, close_redis, open_postgres, open_redis
from store.postgres import (
    append_evidence,
    finalize_investigation,
    get_subreddit_profile,
    make_sessionmaker,
    start_investigation,
    with_session,
)
from store.types import (
    EvidenceRowInput,
    FinalizeInvestigationInput,
    StartInvestigationInput,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(level=settings.log_level, env=settings.env)
    logger = get_logger(__name__)
    settings.validate_for_runtime()  # F-0.7 — fail-closed in prod when keys missing
    logger.info(
        "engine.startup",
        env=settings.env,
        model_reasoner=settings.model_reasoner,
        model_summarizer=settings.model_summarizer,
        hmac_enforced=settings.hmac_enforced,
        gemini_configured=bool(settings.gemini_api_key),
    )

    # F-0.6: probe Postgres + Redis at startup.
    app.state.pg = await open_postgres(settings)
    app.state.redis = await open_redis(settings)
    app.state.pg_sessions = make_sessionmaker(app.state.pg)

    # E-2.11: build Tool Registry + Orchestrator + LLM client.
    registry = ToolRegistry()
    registry.register(ReportVelocityTool(app.state.redis))
    # PolicyMatchTool requires embed + rules_text functions; registered when
    # those are wired (post-MVP). Orchestrator records "skipped" for missing tools.
    app.state.orchestrator = Orchestrator(registry)

    # LLM client — deferred import to avoid hard google-genai dep at import time.
    if settings.gemini_api_key:
        from llm.gemini import GeminiClient  # noqa: PLC0415

        app.state.llm = GeminiClient(settings)
    else:
        app.state.llm = None
        logger.warning("engine.no_llm", reason="GEMINI_API_KEY not set")

    try:
        yield
    finally:
        await close_redis(app.state.redis)
        await close_postgres(app.state.pg)
        logger.info("engine.shutdown")


app = FastAPI(
    title="ModPilot Investigation Engine",
    version="0.0.1",
    description="Context-aware investigation engine for Reddit moderation",
    lifespan=lifespan,
)

# Middleware order matters: HMAC runs *after* correlation-id is bound,
# so a rejection log carries the request's correlation_id.
app.add_middleware(HmacMiddleware)
app.add_middleware(CorrelationIdMiddleware)

register_error_handlers(app)


@app.get("/health")
async def health() -> dict[str, object]:
    """Liveness + readiness + model identifiers. Spec: docs/Specs.md §10.1."""
    settings = get_settings()
    return {
        "ok": True,
        "data": {
            "engine": "0.0.1",
            "git_sha": "unknown",
            "reasoner_prompt": None,
            "summarizer_prompt": None,
            "model_reasoner": settings.model_reasoner,
            "model_summarizer": settings.model_summarizer,
        },
    }


@app.post("/investigate", response_model=InvestigateResponse)
async def investigate(
    req: InvestigateRequest, request: Request
) -> InvestigateResponse:
    """Full pipeline: Strategy -> Orchestrator -> Reasoner -> Validator -> Calibrator.

    Persists investigation + evidence rows. Returns verdict.
    Spec: docs/Specs.md §10.2, docs/04-InvestigationEngine.md §1-§9.
    """
    logger = get_logger(__name__).bind(correlation_id=req.correlation_id)
    logger.info(
        "investigation.requested",
        subreddit_id=req.subreddit_id,
        target_kind=req.target.kind,
        target_id=req.target.id,
        reporter_count=req.report.reporter_count,
    )

    orchestrator: Orchestrator = request.app.state.orchestrator
    llm = request.app.state.llm

    # Fetch subreddit context from DB (cold-start defaults if missing).
    personality = "balanced"
    region = "Global"
    rules = ""
    cold_start = True
    user_risk_tier = "new"
    tier_override = "auto"

    async with with_session(request.app.state.pg_sessions) as session:
        profile = await get_subreddit_profile(
            session, subreddit_id=req.subreddit_id
        )
        if profile is not None:
            personality = profile.personality
            region = profile.region
            rules = profile.rules
            cold_start = profile.cold_start_count < 50
            tier_override = profile.tier_override

    # Run the pipeline.
    result = await run_investigation(
        req=req,
        orchestrator=orchestrator,
        llm=llm,
        personality=personality,
        region=region,
        rules=rules,
        cold_start=cold_start,
        user_risk_tier=user_risk_tier,
        velocity_zscore=0.0,  # TODO(E-3.x): precompute from Redis before pipeline
        rule_match_score=0.0,  # TODO(E-3.x): precompute from embeddings before pipeline
        tier_override=tier_override,
    )

    # Persist investigation + evidence rows.
    await _persist(request, req, result)

    return InvestigateResponse(data=result.verdict)


async def _persist(
    request: Request,
    req: InvestigateRequest,
    result: PipelineResult,
) -> None:
    """Write investigation + evidence + verdict to Postgres."""
    async with with_session(request.app.state.pg_sessions) as session:
        inv = await start_investigation(
            session,
            input_=StartInvestigationInput(
                correlation_id=req.correlation_id,
                subreddit_id=req.subreddit_id,
                target_kind=req.target.kind,
                target_id=req.target.id,
                target_body=req.target.body,
                target_author_id=req.target.author,
                tier=result.tier,
            ),
        )

        for entry in result.accumulator.entries():
            await append_evidence(
                session,
                investigation=inv,
                subreddit_id=req.subreddit_id,
                evidence=EvidenceRowInput(
                    evidence_id=entry.id,
                    tool=entry.tool,
                    summary=entry.summary,
                    detail=entry.detail,
                    status=entry.status,
                    latency_ms=entry.latency_ms,
                ),
            )

        v = result.verdict
        await finalize_investigation(
            session,
            correlation_id=req.correlation_id,
            subreddit_id=req.subreddit_id,
            verdict=FinalizeInvestigationInput(
                risk_tier=v.risk_tier,
                recommendation=v.recommendation,
                calibrated_confidence=v.calibrated_confidence,
                rationale=v.rationale,
                confidence_breakdown={
                    "llm_self_report": v.confidence_breakdown.llm_self_report,
                    "evidence_convergence": v.confidence_breakdown.evidence_convergence,
                    "subreddit_accuracy": v.confidence_breakdown.subreddit_accuracy,
                    "rule_match_strength": v.confidence_breakdown.rule_match_strength,
                },
                model_reasoner=v.model_reasoner,
                model_summarizer=v.model_summarizer,
                cost_usd=v.cost_usd,
                latency_ms=v.latency_ms,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
                validation_flag=v.validation_flag,
                degraded=v.degraded,
                cold_start=v.cold_start,
            ),
        )


# TODO(S-1.6): POST /feedback
# TODO(U-4.7): POST /explain
# TODO(F-0.7): GET /config/{sub_id}
