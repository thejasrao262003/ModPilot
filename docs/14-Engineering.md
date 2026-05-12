# 14 — Engineering

> **Purpose:** How we work. Coding standards, branching, testing strategy, and — most importantly — how to drive Claude Code productively on this repo. This is the team's force-multiplier doc.
>
> **Status:** Living. The Claude Code workflow section evolves as we learn what works.

---

## 1. Operating Principles

Four principles override everything below when in conflict:

1. **Docs lead code.** Specify the contract first; implement second. Underspecified docs produce confused code, especially when Claude Code is the primary author.
2. **One module per concern.** When tempted to split, ask whether the split serves *understanding* or just *file count*. The 18-doc consolidation reflects this principle; so should the code.
3. **Invariants over comments.** Properties enforced by tests outrank properties promised by comments. If it matters, write the test.
4. **Boring beats clever.** This is a hackathon; we ship. Production patterns we've used before > novel patterns we'd have to debug.

---

## 2. Repository Conventions

### 2.1 Layout

Defined authoritatively in `02-Architecture.md` Section 7. Recap of the top-level rules:

- `devvit-app/` — TypeScript. Devvit-specific. Never imports from `engine/`.
- `engine/` — Python. Engine logic. Never imports from `devvit-app/`.
- `eval/` — Python. Evaluation harness. May import from `engine/` for in-process scenario runs.
- `docs/` — Markdown only. No code.
- `scripts/` — One-off ops scripts.

### 2.2 Naming

| Layer | Files | Classes / Types | Functions / Vars |
|---|---|---|---|
| TypeScript (Devvit) | `kebab-case.ts` (handlers) / `PascalCase.tsx` (components) | `PascalCase` | `camelCase` |
| Python (Engine) | `snake_case.py` | `PascalCase` | `snake_case` |

Tests live alongside code:
- Python: `test_<module>.py` next to `<module>.py`
- TypeScript: `<module>.test.ts` next to `<module>.ts`

No separate `tests/` directory. Easier to find; cheaper to maintain.

### 2.3 Imports

- **No circular imports.** Enforced by lint (`ruff` for Python, `eslint-plugin-import` for TS).
- **No deep imports across layers.** Triggers in Devvit import from `services/`, not from `domain/types.ts` directly. The dependency graph from `02-Architecture.md` is enforced by code review.
- **Absolute imports only.** Python: `from engine.orchestrator import ...`. TS: configured paths in `tsconfig.json`.

---

## 3. Coding Standards

### 3.1 Python (Engine)

- **Version:** 3.11+. We use modern syntax (`match`, `|` unions, `Self`).
- **Linter:** `ruff` with strict config. `mypy` for type checking.
- **Async:** all I/O is async. No `time.sleep` in the request path; use `asyncio.sleep`.
- **Type hints:** required on every function signature (`mypy --strict`).
- **Pydantic v2** for all data shapes that cross boundaries (API, store, LLM I/O).
- **Dataclasses** for internal-only structures where Pydantic's validation overhead isn't needed.
- **Error handling:** raise typed exceptions; never `except Exception:` without a re-raise or specific log.
- **Logging:** structured. Use `engine/observability/logging.py` helpers. Never `print()`.
- **No mutable module state.** Module-level globals are constants only. Connection pools live in app state.
- **No `*` imports.** Explicit names only.

Concrete examples:

```python
# Good
async def investigate(report: Report, profile: SubredditProfile) -> Verdict:
    logger.info("investigation.started", correlation_id=report.correlation_id)
    ...

# Bad
def investigate(report, profile):
    print("starting")
    ...
```

### 3.2 TypeScript (Devvit)

- **Strict mode:** `tsconfig.json` has `strict: true`. No `any`.
- **Linter:** `eslint` with `@typescript-eslint/recommended-type-checked`.
- **No `enum`s.** Use `as const` objects or string literal unions. They play better with Devvit's serialization.
- **No `// @ts-ignore` without an explanatory comment.**
- **Async:** all I/O is async. No callback patterns.
- **Devvit-specific:** never call `context.redis` or `context.reddit` directly from triggers/UI; go through `services/`.

```ts
// Good
const investigate: TriggerHandler<'CommentReport'> = async (event, context) => {
  const correlationId = newCorrelationId();
  const logger = makeLogger(context, correlationId);
  ...
};

// Bad
const investigate = async (event: any, context: any) => {
  console.log('reporting');
  ...
};
```

### 3.3 Comments

- **Prefer code clarity to comments.** Rename the variable; don't explain it.
- **Use comments for *why*, not *what*.** Code shows what; comments explain why a non-obvious choice was made.
- **TODOs are tracked.** Format: `// TODO(name): description, ref #issue`. Untracked TODOs fail lint.
- **No dead code.** If it's commented out, delete it. Version control remembers.

---

## 4. Branching & Commits

### 4.1 Branches

- `main` — always deployable.
- `feat/<short-name>` — feature branches.
- `fix/<short-name>` — bug fixes.
- `docs/<short-name>` — doc-only changes.

No long-lived branches. Merge early, merge often.

### 4.2 Commits

Conventional commits. The first line is the contract:

```
type(scope): summary

[optional body]
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`.

Examples:
```
feat(engine): add cold-start demotion to confidence calibrator
fix(devvit): trigger handler swallows reddit api 404
docs(05-memory): correct trust score decay half-life
```

PR titles follow the same format. PR descriptions answer:
- **What** changed.
- **Why** it changed.
- **How** it was tested.

### 4.3 PR Size

Aim for <400 lines changed per PR. Large PRs delay review and increase regression risk. Split into stacked PRs when needed.

### 4.4 Review

Self-review your diff before requesting review. Read it as if someone else wrote it. The most common bug surfaces during this read.

For hackathon: one approving review required for non-doc PRs; no review needed for doc-only PRs.

---

## 5. Testing Strategy

### 5.1 The Pyramid

```
   ┌──────────────────┐
   │  Eval harness    │  ← end-to-end, scenario-driven
   │  (~30 scenarios) │
   ├──────────────────┤
   │  Integration     │  ← module + DB / Redis
   │  (~50 tests)     │
   ├──────────────────┤
   │  Unit            │  ← pure functions, small classes
   │  (~150 tests)    │
   └──────────────────┘
```

### 5.2 What Each Layer Tests

| Layer | Tests |
|---|---|
| **Unit** | Pure functions: priority scoring, confidence calibration, anonymization, evidence accumulator math, prompt-template parsing |
| **Integration** | Tools against real DB/Redis (testcontainers); store layer; LLM client with mocked responses |
| **Eval harness** | End-to-end Engine behavior against scenario library (see `11-Evaluation.md`) |
| **Devvit unit** | Trigger handlers with mocked `context`; UI component rendering |

### 5.3 What We Don't Test

- Devvit platform internals (we test our handler logic, not Reddit's trigger dispatch).
- Gemini API responses (we test our handling of various response shapes via mocks).
- Network failures in unit tests (covered by integration + fault-injection in eval).

### 5.4 Coverage Targets

| Module | Target |
|---|---|
| `engine/orchestrator/` | ≥85% |
| `engine/tools/` | ≥80% |
| `engine/llm/validation.py` | 100% (load-bearing) |
| `engine/llm/anon.py` | 100% (load-bearing) |
| `engine/store/` | ≥75% |
| `devvit-app/src/triggers/` | ≥80% |
| `devvit-app/src/ui/` | ≥60% (rendering tests are noisy; deprioritize) |

Enforced in CI. PRs that drop coverage on load-bearing modules fail the gate.

### 5.5 Test Patterns

**Python:**
```python
@pytest.mark.asyncio
async def test_orchestrator_stops_early_on_convergence():
    fixed_tools = FixedToolRegistry({
        "policy_match": ToolResult(success=True, ...),
        "user_history": ToolResult(success=True, ...),
    })
    orchestrator = Orchestrator(tools=fixed_tools, plan=STANDARD_PLAN)
    result = await orchestrator.run(synthetic_report())
    assert result.timeline[-1].status == "early_stop"
    assert len(result.evidence_rows) == 2
```

**TypeScript:**
```ts
test('onCommentReport skips duplicate within 10 minutes', async () => {
  const context = mockContext();
  await stateStore.put(context, 'pending_investigation:c1', { status: 'complete' });
  await onCommentReport(reportEvent('c1'), context);
  expect(engineClient.investigate).not.toHaveBeenCalled();
});
```

---

## 6. CI Gates

CI configuration lives in `.github/workflows/`. Detailed in `13-Infra.md` Section 7.

Gates for any PR:
1. **Lint** — `ruff` + `eslint` + format checks.
2. **Type check** — `mypy --strict` + `tsc --noEmit`.
3. **Unit tests** — `pytest` + `jest`.
4. **Coverage** — fails if it drops below thresholds on load-bearing modules.
5. **Eval gate** — when prompts or orchestrator change (per `11-Evaluation.md`).
6. **Doc updates** — when relevant: a schema PR without a `07-DataLayer.md` update is rejected.

Total CI time target: <5 minutes for non-eval PRs; <12 minutes including eval gate.

---

## 7. Claude Code Workflow

This is the team's most important section. Claude Code is the primary author on this project. Treat it as a contributor whose strength is execution and whose weakness is context drift.

### 7.1 The Fundamental Rule

> **Always load the relevant area doc before starting a task.**

Per the navigation map in `CLAUDE.md`:

| Working on | Load |
|---|---|
| Devvit triggers, settings, UI | `03-Devvit.md` + `09-UX.md` |
| Investigation engine | `04-InvestigationEngine.md` + `06-AILayer.md` |
| Prompts, models, citation contract | `06-AILayer.md` + `04-InvestigationEngine.md` |
| Database / schema | `07-DataLayer.md` + `05-Memory.md` |
| Verdict card / timeline UI | `09-UX.md` + `04-InvestigationEngine.md` |
| API endpoints | `08-API.md` + `04-InvestigationEngine.md` |
| Reliability / safety | `10-ReliabilityAndSafety.md` |
| Evaluation / scenarios | `11-Evaluation.md` + `01-Product.md` |
| Deployment / infra | `13-Infra.md` |
| Demo / submission | `15-Hackathon.md` + `01-Product.md` |
| Anything user-facing | `Glossary.md` (terminology rules) |

The root `CLAUDE.md` is loaded by default in every session. Other docs are loaded per-task.

### 7.2 Scoping a Task

Good scopes for a Claude Code session:

✅ "Implement `policy_match` tool per `04-InvestigationEngine.md` Section 5.3.1."
✅ "Add the cold-start badge component to the Verdict Card per `09-UX.md` Section 12."
✅ "Write the Alembic migration for the `feedback` table per `07-DataLayer.md` Section 2.8."

Bad scopes:

❌ "Build the engine." (Too large; will drift.)
❌ "Fix the bug in the trigger." (Underspecified; what bug? what behavior?)
❌ "Make the UI nicer." (No reference doc; subjective.)

Rule of thumb: a session should produce one to three logical commits. Larger scopes mean longer context windows and more drift.

### 7.3 Standard Session Structure

```
1. State the task (one sentence).
2. State the reference docs being loaded.
3. State the acceptance criteria (often pulled from the doc).
4. Implement.
5. Run the relevant tests / eval.
6. Verify acceptance criteria.
7. Commit with a conventional commit message.
```

Skipping step 3 is the most common cause of off-target output.

### 7.4 When Claude Code Is Uncertain

Defaults (from root `CLAUDE.md`):

- **When in doubt about terminology**, check `Glossary.md`. Never use banned terms.
- **When proposing a new feature**, check `01-Product.md` Non-Goals first.
- **When changing architecture, schema, or tech stack**, write an ADR first.
- **When generating prompts**, enforce the evidence-citation contract from `06-AILayer.md`.
- **When unsure whether a behavior should be automatic**, default to requiring a moderator click.
- **When information is missing**, leave `// TODO(open-question)` and surface it instead of guessing.

### 7.5 Common Pitfalls

Track these because they recur. When you hit one, add it to the list.

- **Drifting terminology.** Claude Code occasionally reaches for "policy" or "reward" when generating prompts. Catch in review; `Glossary.md` is the authority.
- **Adding files instead of expanding files.** The 18-doc / consolidated-module philosophy gets eroded by "let me make a new utility file." Push back during review.
- **Inline strings and colors.** UI work tends to inline copy and hex colors. Enforce `ui/copy.ts` and `ui/tokens.ts`.
- **Skipping the citation contract.** When generating a new prompt or test scenario, the evidence-citation contract gets forgotten. Always grep for `[ev-` to verify.
- **Forgetting `subreddit_id` filters.** Any new query needs `WHERE subreddit_id = ...`. The sub-isolation invariant is non-negotiable.
- **Importing across layers.** Devvit importing from `engine/` (or vice versa) silently breaks the architecture. CI lint catches most; review catches the rest.

### 7.6 Validation Prompts

Before merging Claude Code's output, run these mental checks:

- Does this break any invariant listed in the relevant doc's "Invariants" section?
- Does it use only the preferred terminology from `Glossary.md`?
- Does the test it added actually test the new behavior (not just call it)?
- Does it touch a doc that should be updated in the same PR?
- Could this fail catastrophically? If yes, is there graceful degradation?

If any answer is unclear, ask Claude Code to address it before merging.

### 7.7 When to Resist Claude Code

Three cases where pushback matters:

1. **"Let me refactor while I'm here."** Refactors are separate PRs. Mixing them with feature work obscures both.
2. **"I'll add a helper module for this."** Often the answer is to expand an existing module. Push back unless the new file maps to a distinct concern in the doc structure.
3. **"I'll handle this case by adding a flag."** Configuration sprawl is real. Ask whether the case belongs in cold-start, personality, or is genuinely a new concern.

### 7.8 The Doc-Sync Rule

When code changes invalidate a doc, the same PR updates the doc. This is the single most important rule for keeping docs alive:

- New API endpoint → update `08-API.md` in the same PR.
- New table or column → update `07-DataLayer.md` in the same PR.
- New tool → update `04-InvestigationEngine.md` Section 5 in the same PR.
- New UI component → update `09-UX.md` Section 14 in the same PR.
- New invariant added or removed → update the relevant doc's Invariants section.

CI doesn't enforce this mechanically; code review does.

---

## 8. ADR Process

Architecture Decision Records live in `docs/adr/`. Used when:

- Tech stack changes.
- A documented invariant changes.
- A "we considered and rejected" decision needs reversing.
- A non-obvious design choice deserves explicit rationale.

### 8.1 Template

```
# ADR NNNN: <Title>

Status: Proposed | Accepted | Superseded
Date: YYYY-MM-DD

## Context
What problem are we solving? What constraints exist?

## Decision
What did we decide?

## Consequences
What changes as a result? Trade-offs?

## Alternatives Considered
What did we look at and reject? Why?
```

### 8.2 Numbering

Strictly sequential. Never reuse numbers. Superseded ADRs link to the new one but stay in the directory for history.

### 8.3 Starter ADRs

Already drafted:
- `0001-devvit-plus-external-backend.md`
- `0002-no-online-rl.md`
- `0003-evidence-citation-required.md`
- `0004-human-in-the-loop-mandatory.md`

Add more as decisions accumulate.

---

## 9. Documentation Maintenance

### 9.1 Doc Drift Is Worse Than No Docs

A wrong doc is more damaging than a missing one because it actively misleads. Two rules:

1. **Same-PR doc updates** (Section 7.8).
2. **Weekly doc review** — every Friday, the team reviews the docs touched that week and verifies they still reflect the code. Discrepancies are fixed in the same review.

### 9.2 Doc Tier Awareness

Per `CLAUDE.md`, three tiers:
- **Canon** (rarely changes): `01-Product.md`, `02-Architecture.md`, `Glossary.md`, ADRs.
- **Living** (evolves continuously): most area docs.
- **Working** (transient): submission docs, sprint notes.

Touching a Canon doc requires the same care as touching a load-bearing module: discuss first, then commit.

### 9.3 Doc Length Discipline

If a doc grows beyond ~6,000 words, split is acceptable. Until then, keep things consolidated. Splitting prematurely fragments context and makes Claude Code's job harder.

---

## 10. Engineering Invariants

Properties that must always hold:

1. Every change to a public contract (API, schema, prompt) updates the relevant doc in the same PR.
2. Every load-bearing module has tests with ≥80% coverage.
3. Every persisted query is `subreddit_id`-scoped.
4. No `Exception` is caught without being either re-raised, logged with context, or handled by a specific recovery path.
5. No new file is added when an existing file's purpose fits the new code.
6. No banned terminology (per `Glossary.md`) appears in user-facing strings, prompts, or UI copy.
7. No PR merges with a failing eval gate (when applicable).
8. No commits push directly to `main` (always via PR, even for solo dev — keeps history reviewable).

Violating these is an engineering bug.

---

## 11. Working in a Hackathon Sprint

For the 14-day hackathon specifically:

### 11.1 Daily Cadence

- **Morning:** review the active priorities in root `CLAUDE.md`. Pick the next task from the implementation order in the relevant area doc.
- **During:** stay in one area doc per session. Resist scope creep across areas.
- **Evening:** commit what's working. Open PRs even if not ready to merge — they're checkpoints.

### 11.2 Friction Removal

Set up these once and never think about them again:
- Pre-commit hooks: ruff, eslint, format-on-save.
- Local services: docker-compose for Postgres + Redis, started by `make services-up`.
- `.env` files filled in with working API keys.
- Test subreddit on Reddit with Devvit app pre-installed.
- One bash alias per common command.

Time spent on friction removal in Day 1 returns 10x across days 2–14.

### 11.3 When You're Stuck

In priority order:
1. Re-read the relevant doc section. Often the answer is there.
2. Check the open-questions list in root `CLAUDE.md`.
3. Write a `TODO(open-question)` and move on; resolve at the next sync point.
4. Drop scope. The MVP list in `01-Product.md` is the ceiling, not the floor.

### 11.4 Demo Prep Is Engineering

The last 2 days of the sprint are dedicated to demo polish per `15-Hackathon.md`. Treat them as engineering work, not "marketing." Reliable demo flow is a feature of the product.

---

## 12. Open Questions

- **Should we adopt pre-commit doc-link validation?** Tempting; defer until link rot is observed.
- **Should we generate API docs from FastAPI's OpenAPI output and link them?** Probably yes post-MVP; for hackathon, `08-API.md` is hand-maintained.
- **Should we add property-based testing for the Calibrator and Strategy Selector?** Strong candidates; defer until basic coverage is in place.

Tracked in root `CLAUDE.md`.

---

## 13. Related Documents

- [`CLAUDE.md`](../CLAUDE.md) — Root system memory; the operating contract.
- [`01-Product.md`](01-Product.md) — Non-goals, scope guardrails.
- [`02-Architecture.md`](02-Architecture.md) — Repo layout, dependency rules.
- [`07-DataLayer.md`](07-DataLayer.md) — Schema discipline, migration process.
- [`11-Evaluation.md`](11-Evaluation.md) — Eval gates that block merge.
- [`13-Infra.md`](13-Infra.md) — CI workflow specifics, deploy process.
- [`15-Hackathon.md`](15-Hackathon.md) — Sprint planning, demo prep.
- [`Glossary.md`](Glossary.md) — Terminology authority.
- [`adr/`](adr/) — Decision records.