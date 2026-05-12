# Evaluation Harness

Scenario-driven end-to-end testing for the Investigation Engine.

> Spec: [`../docs/11-Evaluation.md`](../docs/11-Evaluation.md) · Pipeline: [`../docs/Specs.md §16`](../docs/Specs.md)

## Layout

| Path | Purpose |
|---|---|
| `scenarios/` | JSON fixtures — one file per scenario |
| `runner/` | Harness that loads scenarios and exercises the engine in-process (lands in V-5.2) |
| `baseline.json` | Pinned accuracy + calibration baselines (lands in V-5.3) |

## Quickstart

```bash
uv sync --extra dev
uv run python -m runner.cli --suite all
uv run python -m runner.cli --scenario harassment_high_conf_remove
```

## Layer rule

`eval/` MAY import from `engine/` (invariant I-8). The import is declared in `pyproject.toml`.
