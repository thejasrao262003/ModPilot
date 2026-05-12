# Investigation Engine

Python 3.11+ · FastAPI · asyncio. The investigation pipeline behind ModPilot.

> Spec: [`../docs/04-InvestigationEngine.md`](../docs/04-InvestigationEngine.md) · API: [`../docs/08-API.md`](../docs/08-API.md) · LLM: [`../docs/06-AILayer.md`](../docs/06-AILayer.md)

## Quickstart

```bash
uv sync --extra dev
cp .env.example .env       # fill GEMINI_API_KEY, DB urls
uv run uvicorn api.main:app --reload --port 8000
```

## Layout

| Module | Purpose |
|---|---|
| `api/` | FastAPI endpoints — see [`../docs/Specs.md §10`](../docs/Specs.md) |
| `orchestrator/` | Strategy Selector, investigation loop, budgets |
| `tools/` | Tool Registry implementations |
| `llm/` | Gemini client, prompts, citation validator |
| `memory/` | User / thread / subreddit memory + cold-start |
| `store/` | Postgres + Redis access |
| `observability/` | Structured logging helpers |

## Tests

```bash
uv run pytest                      # all
uv run pytest tools/test_policy_match.py::test_basic -v   # single
uv run pytest --cov                # with coverage
```

Coverage targets in [`../docs/14-Engineering.md §5.4`](../docs/14-Engineering.md).
