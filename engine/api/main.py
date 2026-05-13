"""ModPilot Investigation Engine — FastAPI entry point.

Spec: docs/Specs.md §10, docs/08-API.md
Real `/investigate`, `/feedback`, `/explain`, `/config` land in later tasks
(E-2.11, S-1.6, U-4.7, F-0.7).
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from api.canned import canned_verdict
from api.config import get_settings
from api.errors import register_error_handlers
from api.middleware import CorrelationIdMiddleware, HmacMiddleware
from api.schemas import InvestigateRequest, InvestigateResponse
from observability.logging import configure_logging, get_logger
from store.connections import close_postgres, close_redis, open_postgres, open_redis
from store.postgres import make_sessionmaker


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

    # F-0.6: probe Postgres + Redis at startup. Failure here aborts boot
    # in production (per docs/Specs.md §13.1 fail-closed) so we never serve
    # /investigate calls against unreachable stores.
    app.state.pg = await open_postgres(settings)
    app.state.redis = await open_redis(settings)
    # E-2.2: session factory for repository helpers. Handlers open sessions
    # via `async with with_session(request.app.state.pg_sessions) as s:`.
    app.state.pg_sessions = make_sessionmaker(app.state.pg)
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
async def investigate(req: InvestigateRequest) -> InvestigateResponse:
    """Stub endpoint — returns a canned HIGH-conf REMOVE verdict (S-1.3).

    Real pipeline (Strategy → Orchestrator → Reasoner → Validator → Calibrator)
    lands in E-2.11. Until then this returns the same shape so Devvit + UI work
    can proceed in parallel.
    """
    logger = get_logger(__name__).bind(correlation_id=req.correlation_id)
    logger.info(
        "investigation.stub.requested",
        subreddit_id=req.subreddit_id,
        target_kind=req.target.kind,
        target_id=req.target.id,
        reporter_count=req.report.reporter_count,
    )
    return InvestigateResponse(data=canned_verdict(req))


# TODO(E-2.11): replace canned verdict with full Strategy → Orchestrator → Reasoner pipeline
# TODO(S-1.6): POST /feedback
# TODO(U-4.7): POST /explain
# TODO(F-0.7): GET /config/{sub_id}
