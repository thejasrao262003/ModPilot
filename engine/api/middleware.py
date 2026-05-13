"""HMAC + correlation-id middleware.

Spec: docs/Specs.md §10 (HMAC), §15 (correlation_id in every log).
Dev mode: middleware is permissive — logs a warning and lets the request through
when `ENGINE_SHARED_SECRET` is unset. Production: rejects with UNAUTHORIZED.
"""

from __future__ import annotations

import hmac
import time
import uuid
from hashlib import sha256
from typing import TYPE_CHECKING

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from api.config import get_settings
from api.errors import ErrorBody, ErrorEnvelope

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from fastapi import Request, Response

logger = structlog.get_logger(__name__)

# Endpoints that bypass HMAC entirely (health probes, no body).
_PUBLIC_PATHS: frozenset[str] = frozenset({"/health", "/docs", "/openapi.json", "/redoc"})

# Header names — matched on the Devvit-side client.
HEADER_SIGNATURE = "x-modpilot-signature"
HEADER_CORRELATION = "x-correlation-id"
HEADER_TIMESTAMP = "x-modpilot-timestamp"

# Tolerance for clock skew on signed requests.
_MAX_SKEW_SECONDS = 300


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    """Bind `correlation_id` into structlog context for the request's lifetime."""

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        correlation_id = request.headers.get(HEADER_CORRELATION) or str(uuid.uuid4())
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            correlation_id=correlation_id,
            path=request.url.path,
            method=request.method,
        )
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.clear_contextvars()
        response.headers[HEADER_CORRELATION] = correlation_id
        return response


class HmacMiddleware(BaseHTTPMiddleware):
    """Verify `X-Modpilot-Signature` against HMAC-SHA256 of the raw body.

    Dev mode (no `ENGINE_SHARED_SECRET`): log + pass through. This keeps the
    invariant "Engine refuses to start without a secret in prod" landing in F-0.7.
    """

    async def dispatch(  # noqa: PLR0911 — guard chain reads cleaner with explicit returns
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if request.url.path in _PUBLIC_PATHS or request.method == "OPTIONS":
            return await call_next(request)

        settings = get_settings()

        if not settings.hmac_enforced:
            if not settings.engine_shared_secret:
                logger.warning(
                    "hmac.permissive",
                    reason="ENGINE_SHARED_SECRET not configured",
                    env=settings.env,
                )
            return await call_next(request)

        body = await request.body()
        signature = request.headers.get(HEADER_SIGNATURE, "")
        timestamp = request.headers.get(HEADER_TIMESTAMP, "")

        if not signature or not timestamp:
            return _unauthorized("missing signature or timestamp")

        try:
            skew = abs(time.time() - float(timestamp))
        except ValueError:
            return _unauthorized("malformed timestamp")
        if skew > _MAX_SKEW_SECONDS:
            return _unauthorized(f"timestamp skew {skew:.0f}s exceeds {_MAX_SKEW_SECONDS}s")

        expected = hmac.new(
            settings.engine_shared_secret.encode("utf-8"),
            f"{timestamp}.".encode() + body,
            sha256,
        ).hexdigest()

        if not hmac.compare_digest(expected, signature):
            return _unauthorized("signature mismatch")

        return await call_next(request)


def _unauthorized(message: str) -> JSONResponse:
    body = ErrorEnvelope(error=ErrorBody(code="UNAUTHORIZED", message=message, retryable=False))
    return JSONResponse(status_code=401, content=body.model_dump())
