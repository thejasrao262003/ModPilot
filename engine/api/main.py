"""ModPilot Investigation Engine — FastAPI entry point.

Spec: docs/Specs.md §10, docs/08-API.md
Real endpoints land in F-0.5 (skeleton) and E-2.11 (full /investigate).
"""

from fastapi import FastAPI

app = FastAPI(
    title="ModPilot Investigation Engine",
    version="0.0.1",
    description="Context-aware investigation engine for Reddit moderation",
)


@app.get("/health")
async def health() -> dict[str, object]:
    """Liveness + readiness + model identifiers. Spec: docs/Specs.md §10.1."""
    return {
        "ok": True,
        "data": {
            "engine": "0.0.1",
            "git_sha": "unknown",
            "reasoner_prompt": None,
            "summarizer_prompt": None,
            "model_reasoner": "gemini-2.5-pro",
            "model_summarizer": "gemini-2.5-flash",
        },
    }


# TODO(F-0.5): HMAC middleware
# TODO(E-2.11): POST /investigate
# TODO(S-1.6): POST /feedback
# TODO(U-4.7): POST /explain
# TODO(F-0.7): GET /config/{sub_id}
