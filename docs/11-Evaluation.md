# 11 — Evaluation

> **Purpose:** Specify the offline evaluation system that gates prompt changes, validates engine behavior, and provides the demoable "ModPilot regression tests its own moderation decisions" story. Load when working on prompts, engine logic, or any change that could shift recommendation quality.
>
> **Status:** Living. Scenario library grows with every new edge case we hit.

---

## 1. Why Evaluation Exists

Three concrete jobs:

1. **Gate prompt changes.** Every PR that touches `engine/llm/prompts/` runs the harness. Regressions block the merge.
2. **Validate engine behavior end-to-end.** Strategy Selector, Orchestrator, Reasoner, Calibrator — all exercised against repeatable scenarios.
3. **Tell the story.** "Our offline evaluation harness re-runs 100+ moderation scenarios on every change. We don't ship if accuracy regresses." That's a defensible production-engineering claim.

The harness is the productized reuse of our OpenENV scenario library. It does not train models. It evaluates them.

---

## 2. Architecture

```
eval/
├── harness.py                 # entry point: runs scenarios against the engine
├── scenarios/                 # JSON scenarios, one file per case
│   ├── 001_obvious_spam.json
│   ├── 002_borderline_self_promo.json
│   ├── 003_harassment_escalation.json
│   └── ...
├── openenv_adapter.py         # converts OpenENV scenarios → eval format
├── reports/                   # generated eval reports (gitignored)
└── baselines/                 # committed baseline metrics per prompt version
    └── reasoner-v1.0.json
```

The harness runs **in-process** against the Engine code (importing modules, not over HTTP). This avoids network flakiness in CI and makes scenarios fast.

---

## 3. Scenario Format

Each scenario is a JSON file with a fixed shape.

```json
{
  "id": "003_harassment_escalation",
  "category": "harassment",
  "description": "Escalation in a heated thread; clear personal attacks at turn 8+",

  "input": {
    "subreddit_id": "test_sub",
    "subreddit_profile": "balanced",
    "cold_start": false,
    "report": {
      "target_id": "comment_x",
      "target_type": "comment",
      "author_id": "user_a",
      "report_reason": "harassment",
      "report_count": 4,
      "reports_per_minute": 0.8
    },
    "fixed_tool_results": {
      "policy_match": [
        { "rule_id": "rule-2", "rule_text": "No personal attacks", "similarity": 0.81 }
      ],
      "user_history": {
        "prior_violations": { "harassment": 2 },
        "trust_tier": "watched"
      },
      "thread_context": {
        "escalation_points": [{ "turn": 8, "temperature": 0.7 }],
        "off_topic": false
      }
    }
  },

  "expected": {
    "recommendation": "REMOVE",
    "confidence_min": 0.75,
    "confidence_max": 0.95,
    "must_cite_evidence_types": ["rule_match", "prior_violations", "escalation"],
    "validation_must_pass": true,
    "tier_at_most": "STANDARD"
  },

  "tags": ["regression", "demo", "p0"]
}
```

### 3.1 Key Design Decisions

- **Tool results are fixed.** We don't actually run tools against synthetic Reddit data — we pre-bake what tools would return. This isolates the Reasoner + Calibrator as the variables under test.
- **Expectations are ranges, not exact matches.** Confidence varies; we test that it falls in the right band.
- **Tags drive selection.** `p0` = must pass before any release. `regression` = part of the gate. `demo` = used in the hackathon demo.

### 3.2 Scenario Catalog (MVP)

At least one scenario per canonical use case in `01-Product.md` Section 6:

| ID | Scenario | Tier expected | Recommendation |
|---|---|---|---|
| 001 | Obvious spam | FAST | REMOVE high conf |
| 002 | Borderline self-promo | STANDARD | NO_ACTION mid conf |
| 003 | Harassment escalation | STANDARD/DEEP | REMOVE high conf |
| 004 | Coordinated brigading | DEEP | ESCALATE high conf |
| 005 | Misinformation, political sub | STANDARD/DEEP | varies by personality |
| 006 | Edge-case approval (quote vs. attack) | STANDARD | APPROVE mid conf |
| 007 | False-flag report | FAST | APPROVE high conf |
| 008 | Repeat offender, borderline | STANDARD | REMOVE mid-high conf |
| 009 | Novel violation, ambiguous | STANDARD | NO_ACTION low conf |
| 010 | High-volume queue triage | mixed | tier distribution test |

Plus failure-mode scenarios:
- 020 — Reasoner hallucinates evidence ID → validation must fail
- 021 — Contradictory evidence → confidence must demote
- 022 — Partial investigation → confidence must demote
- 023 — Cold-start subreddit → high tier, no auto-prefill
- 024 — Strict personality on the same input as 002 → REMOVE instead of NO_ACTION
- 025 — Lenient personality on the same input as 008 → NO_ACTION instead of REMOVE

The full set lives in `eval/scenarios/` and grows over time. Every reported bug becomes a scenario.

---

## 4. Harness Execution

### 4.1 Run

```bash
uv run python -m eval.harness --tags p0,regression --prompt-version reasoner-v1.0
```

Or, in CI:

```bash
make eval-gate
```

### 4.2 Per-Scenario Flow

1. Load scenario JSON.
2. Construct an Engine with fixed tool results injected via dependency injection (the `ToolRegistry` is swapped for a `FixedToolRegistry`).
3. Run the Strategy Selector → Orchestrator → Reasoner → Calibrator pipeline.
4. Compare actual verdict against scenario `expected`.
5. Record pass/fail + diagnostic details.

### 4.3 Concurrency

Scenarios run in parallel up to `--max-concurrent` (default 8). LLM calls are real (not mocked) — we want to measure actual model behavior. Total cost per full run: ~$1–2 at MVP scenario count.

---

## 5. Evaluation Metrics

Computed per run, compared against the baseline for the prompt version.

| Metric | Definition | Why it matters |
|---|---|---|
| **Recommendation accuracy** | % scenarios where `recommendation` matches expected | The primary gate |
| **Confidence calibration RMSE** | RMSE between actual confidence and midpoint of expected range | Catches overconfident drift |
| **Validation pass rate** | % scenarios where validation passes (when expected) | Hallucination detector |
| **Evidence citation completeness** | % scenarios where all `must_cite_evidence_types` are cited | Citation contract regression check |
| **Tier accuracy** | % scenarios where chosen tier ≤ `tier_at_most` | Cost discipline |
| **Average latency per tier** | wall-clock per FAST/STANDARD/DEEP | Latency regression |
| **Average cost per tier** | $ per FAST/STANDARD/DEEP | Cost regression |

---

## 6. Regression Gates

CI enforces these on every PR touching the engine or prompts:

| Metric | Threshold |
|---|---|
| Recommendation accuracy | ≥ baseline − 2 percentage points |
| Validation pass rate | ≥ 95% |
| Citation completeness | ≥ baseline − 5 percentage points |
| Tier accuracy | ≥ 95% |
| Cost regression | ≤ baseline + 10% |
| Latency regression | ≤ baseline + 15% |
| **Any `p0` scenario failing** | Hard block — no merge |

Failures generate a comment on the PR with the specific scenarios that regressed.

---

## 7. Baselines

Baselines are committed JSON files per prompt version: `eval/baselines/reasoner-v1.0.json`.

```json
{
  "prompt_version": "reasoner-v1.0",
  "engine_version": "1.2.3",
  "established_at": "2026-05-12T10:00:00Z",
  "scenarios_run": 47,
  "metrics": {
    "recommendation_accuracy": 0.94,
    "confidence_calibration_rmse": 0.08,
    "validation_pass_rate": 0.98,
    "citation_completeness": 0.96,
    "tier_accuracy": 0.97,
    "avg_cost_usd": { "FAST": 0.003, "STANDARD": 0.018, "DEEP": 0.041 },
    "avg_latency_ms": { "FAST": 750, "STANDARD": 2800, "DEEP": 6200 }
  }
}
```

### 7.1 Establishing a Baseline

A new baseline is created when:
- A new prompt version is introduced (major version bump → new file).
- A previously-failing scenario is fixed and accepted (minor version bump → re-baseline).

Establishment requires a full eval run + sign-off in the PR description.

### 7.2 Baseline Drift

If `actual − baseline > threshold`, gate fails. If `actual − baseline < −threshold` (we improved), no failure but the PR description should note "improvement; consider re-baselining."

We don't auto-update baselines. Improvements are owned by the engineer.

---

## 8. OpenENV Adapter

The OpenENV Content Moderation work produced a scenario library. We reuse it.

### 8.1 What the Adapter Does

`eval/openenv_adapter.py` converts OpenENV scenarios into ModPilot eval scenarios:

- Maps OpenENV's observation space → fixed tool results in our format.
- Maps OpenENV's expected actions → our `recommendation` enum.
- Drops RL-specific fields (rewards, trajectories) — we use scenarios as deterministic test cases, not training episodes.

### 8.2 What We Don't Use From OpenENV

- The reward signal logic (our Calibrator does that work differently).
- The RL training loop (we don't train).
- The trajectory exploration (our Investigation Timeline is the same idea, but it's a UI feature here).

### 8.3 The Story for Judges

> "ModPilot's evaluation harness regression-tests every prompt change against 100+ moderation scenarios derived from our prior OpenENV research. If accuracy drops, the change doesn't ship."

That's the entire pitch. The OpenENV provenance is mentioned briefly; the productized harness is the deliverable.

---

## 9. Manual Evaluation

Some questions can't be answered by automated harness alone — calibration vs. real subreddit norms, edge cases the harness doesn't represent, demo polish quality.

### 9.1 Manual Review Cadence

- Weekly during build: spot-check 5 random verdicts from the eval run against engineer judgment.
- Pre-submission: a 30-scenario manual walkthrough where the team scores each verdict ("would a mod find this useful?").

### 9.2 Manual Evaluation Rubric

For each scenario, score 1–5:

- **Evidence quality** — were the right facts surfaced?
- **Rationale clarity** — would a mod understand the reasoning?
- **Confidence appropriateness** — too sure / too unsure / about right?
- **Citation correctness** — does every claim cite real evidence?

Targets: average ≥4.0 on all four axes across the 30-scenario sample.

### 9.3 Scoring Sheet

Lives in `eval/manual/scoring.md`. Updated each pre-submission review.

---

## 10. CI Integration

Workflow file: `.github/workflows/engine-ci.yml`.

### 10.1 Triggered By

- Any change to `engine/llm/prompts/**`
- Any change to `engine/orchestrator/**`
- Any change to `engine/tools/**`
- Any change to `eval/**`

### 10.2 Steps

1. Lint + unit tests (fast).
2. Eval harness with `--tags p0,regression`.
3. Diff metrics against committed baseline.
4. Pass/fail with a comment on the PR.

### 10.3 Cost Budgeting in CI

CI eval cost: capped at $3/run. We sample `regression` scenarios if the full set exceeds budget; `p0` scenarios always run.

---

## 11. Deterministic Re-Run

Critical: scenarios must be deterministic across runs to be useful for gating.

### 11.1 What We Control

- **Temperature = 0.0** on all LLM calls.
- **Pinned model versions** in config.
- **Fixed seeds** in any random sampling (tier selection bandit, evidence ordering).
- **Fixed timestamps** in scenarios (no `now()` calls).
- **Fixed anonymization** — token assignment is deterministic per scenario.

### 11.2 What We Don't Control

- Subtle LLM output variation despite temperature 0 (rare but real).
- Provider-side model updates (we pin versions, but providers occasionally patch).

Mitigation: rerun flaky scenarios up to 3 times in CI. A scenario passing 2 of 3 is acceptable; failing 3 of 3 is a real regression.

---

## 12. Cold-Start and Personality Coverage

The harness must validate that the system's adaptive behaviors actually work.

### 12.1 Cold-Start Scenarios

Scenarios 023, 026, 027 explicitly set `cold_start: true` and expect:
- No FAST tier selection.
- Higher confidence threshold for recommendations.
- No primary action button styling (validated downstream in UI tests, not harness).

### 12.2 Personality Scenarios

Scenarios 024, 025, 028, 029 run the *same input* through different personalities and expect *different verdicts*:

- 002 (Balanced) → NO_ACTION
- 024 (Strict, same input) → REMOVE
- 025 (Lenient, alt input) → NO_ACTION instead of REMOVE

This is the single most demoable test: judges see the same case produce different verdicts based on the personality setting. The harness validates this works.

---

## 13. Failure Mode Scenarios

A subset of scenarios exists to test that the system fails honestly.

| ID | Failure mode | Expected behavior |
|---|---|---|
| 020 | Reasoner hallucinates evidence ID | Validation fails → corrective retry → demote to LOW |
| 021 | Contradictory evidence | Confidence ≤ 0.6 |
| 022 | Partial investigation (budget exhausted) | `is_partial: true`, confidence demoted |
| 030 | Fallback (LLM unavailable) | `fallback: true`, confidence ≤ 0.55, conservative recommendation |
| 031 | Validation fails twice | Verdict ships, `validation_failed: true`, LOW conf, no HIGH conf possible |

These scenarios use mocked LLM clients that simulate the failure modes. They run in the eval gate.

---

## 14. Reporting

After each run, the harness emits:

### 14.1 Report Files

- `eval/reports/<timestamp>/summary.json` — metrics + pass/fail
- `eval/reports/<timestamp>/details.json` — per-scenario verdict + diff against expected
- `eval/reports/<timestamp>/regressions.md` — human-readable summary of failures

### 14.2 PR Comment

CI posts a comment with the regression summary:

```
## Eval gate: ⚠️ regressions detected

Prompt version: reasoner-v1.1 (vs baseline reasoner-v1.0)

✅ Recommendation accuracy: 0.93 (baseline 0.94, threshold ≥ 0.92)
❌ Validation pass rate: 0.91 (threshold ≥ 0.95)
✅ Tier accuracy: 0.96
✅ Cost: +4% (threshold ≤ +10%)

Failing scenarios (p0):
- 020_reasoner_hallucinates → validation passed when it should have failed
- 027_cold_start_strict → tier selected FAST (expected STANDARD+)

See full report: eval/reports/2026-05-12T14-22-00/
```

---

## 15. Eval Invariants

Properties that must always hold:

1. Every PR touching prompts or engine code runs the eval gate before merge.
2. No `p0` scenario can be skipped or marked "expected failure."
3. Baselines are immutable per version; new baselines require new versions.
4. The harness runs in-process; no production traffic is used for eval.
5. No scenario uses real user data; all are synthetic or anonymized historical.
6. Scenarios are deterministic enough that a 2-of-3 rerun policy is sufficient.
7. The OpenENV adapter is read-only; we never train against scenarios.

Violating these is a bug.

---

## 16. Open Questions

- **At what scenario count does manual review become impractical?** Probably 100+. We're at ~30 for MVP.
- **Should we run eval against real (anonymized) historical reports from a partner subreddit?** Tempting; defer until we have a partner.
- **Should the harness verify Timeline UI rendering?** Currently harness validates verdict + evidence; UI rendering is tested separately in Devvit unit tests.

Tracked in root `CLAUDE.md`.

---

## 17. Demo Use

For the hackathon, the harness is itself a demo asset:

- Show the CLI run on stage: "We just ran 47 scenarios in 30 seconds at a cost of $0.84. All passed."
- Show a synthetic regression: introduce a prompt typo, watch the gate fail.
- Show the personality comparison: same scenario, different personalities, different outcomes.

The eval harness is the proof point that ModPilot is operationally serious. Use it.

---

## 18. Related Documents

- [`01-Product.md`](01-Product.md) — Canonical use cases that drive scenario design.
- [`04-InvestigationEngine.md`](04-InvestigationEngine.md) — What the harness exercises.
- [`05-Memory.md`](05-Memory.md) — Personality and cold-start behaviors validated here.
- [`06-AILayer.md`](06-AILayer.md) — Prompt versioning and eval baseline references.
- [`14-Engineering.md`](14-Engineering.md) — CI workflow setup.
- [`15-Hackathon.md`](15-Hackathon.md) — How the harness features in the demo.