"""Error envelope + exception handlers.

Wire format per docs/Specs.md §10.3:
    { "ok": false, "error": { "code": "...", "message": "...", "retryable": bool } }
"""

from typing import Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

ErrorCode = Literal[
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "RATE_LIMITED",
    "BUDGET_EXHAUSTED",
    "ENGINE_DEGRADED",
    "TIMEOUT",
    "INTERNAL",
]

_RETRYABLE: set[ErrorCode] = {"RATE_LIMITED", "ENGINE_DEGRADED", "TIMEOUT"}

_STATUS_FOR_CODE: dict[ErrorCode, int] = {
    "BAD_REQUEST": 400,
    "UNAUTHORIZED": 401,
    "RATE_LIMITED": 429,
    "BUDGET_EXHAUSTED": 429,
    "ENGINE_DEGRADED": 503,
    "TIMEOUT": 504,
    "INTERNAL": 500,
}


class ErrorBody(BaseModel):
    code: ErrorCode
    message: str
    retryable: bool


class ErrorEnvelope(BaseModel):
    ok: Literal[False] = False
    error: ErrorBody


class EngineError(Exception):
    """Raised by handlers; serialized to the canonical error envelope."""

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    @property
    def retryable(self) -> bool:
        return self.code in _RETRYABLE

    @property
    def status_code(self) -> int:
        return _STATUS_FOR_CODE[self.code]


def _envelope(code: ErrorCode, message: str) -> JSONResponse:
    body = ErrorEnvelope(error=ErrorBody(code=code, message=message, retryable=code in _RETRYABLE))
    return JSONResponse(status_code=_STATUS_FOR_CODE[code], content=body.model_dump())


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(EngineError)
    async def _engine_error(_req: Request, exc: EngineError) -> JSONResponse:
        return _envelope(exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_req: Request, exc: RequestValidationError) -> JSONResponse:
        # Pydantic / FastAPI validation failure -> BAD_REQUEST envelope
        message = "; ".join(
            f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
        )
        return _envelope("BAD_REQUEST", message or "validation failed")

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_req: Request, exc: StarletteHTTPException) -> JSONResponse:
        code: ErrorCode = (
            "UNAUTHORIZED" if exc.status_code == 401
            else "BAD_REQUEST" if exc.status_code in (400, 404, 405)
            else "RATE_LIMITED" if exc.status_code == 429
            else "INTERNAL"
        )
        # Preserve the original HTTP status — `_envelope` would re-map it via _STATUS_FOR_CODE.
        body = ErrorEnvelope(
            error=ErrorBody(code=code, message=str(exc.detail), retryable=code in _RETRYABLE)
        )
        return JSONResponse(status_code=exc.status_code, content=body.model_dump())
