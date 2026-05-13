# ADR 0005: Devvit Web (Hono server) instead of Devvit Blocks

Status: Accepted
Date: 2026-05-13

## Context

Original architecture (docs/03-Devvit.md, docs/09-UX.md, docs/Specs.md §6) assumed **Devvit Blocks UI** — a declarative TypeScript component library that compiles to platform-rendered primitives. Triggers were registered via `Devvit.addTrigger(...)`, UI built from `<vstack>` / `<hstack>` / `<text>` Blocks.

When we ran `npm create devvit@latest` against the Reddit-provided token to scaffold the app (F-0.4), Reddit's current blessed template generated a **Devvit Web** project instead:

- Server: **Hono** running on `@devvit/web/server`
- Build: **Vite** → `dist/server/index.cjs`
- Config: **`devvit.json`** (JSON Schema-validated) declaring menu items, forms, triggers, and scheduler tasks as HTTP endpoints
- Trigger model: platform POSTs to `/internal/triggers/<name>` with a typed request body
- UI: web (HTML/CSS/JS), not Blocks

This is the architecture Reddit's tooling now generates by default. Fighting it would mean ejecting from the blessed scaffold and losing build/deploy integration.

## Decision

Adopt the **Devvit Web** architecture as scaffolded by `npm create devvit@latest`.

- The Devvit app is a Hono server with endpoints under `/internal/triggers/`, `/internal/menu/`, `/internal/form/`, `/internal/scheduler/`, and (eventually) a web frontend mounted at `/`.
- Triggers, menu items, forms, and scheduler tasks are declared in [`devvit-app/devvit.json`](../../devvit-app/devvit.json) with corresponding handler routes in `src/routes/`.
- UI surfaces (Verdict Card, Investigation Timeline, Mod Dashboard) ship as web pages/components rather than Blocks primitives. This is what [`mockups/moderator-ui.html`](../../mockups/moderator-ui.html) already prototyped.

## Consequences

**Positive:**
- The Forensic Dossier aesthetic from the mockup is **now achievable** — full CSS/typography control, real Fraunces + Geist + JetBrains Mono, paper-grain SVG overlay, the lot.
- The Hono request/response model matches the Engine's FastAPI model — both sides reason about HTTP envelopes, not Blocks state.
- Trigger handlers are testable as plain HTTP routes with Hono's test helper, not as Devvit-runtime-bound classes.
- Vite gives us hot reload + sourcemaps + tree-shaking.

**Negative / doc-sync debt:**
- Docs need a sweep. Specifically:
  - `docs/03-Devvit.md` — replace Blocks references with Web equivalents.
  - `docs/Specs.md §6` — update layout (`devvit.json` not `devvit.yaml`; routes not handlers).
  - `docs/09-UX.md §2 + §14` — UI components no longer Blocks; tokens still live in `ui/tokens.ts` (kept the contract, swapped the substrate).
  - `docs/14-Engineering.md §3.2` — TypeScript rules unchanged; Devvit-specific guidance shifts from "never call `context.redis` directly" to "service objects mediate `@devvit/web/server` access."
- The `Devvit Blocks constraints are creative constraints` line in [09-UX.md §1.5](../09-UX.md) is now obsolete; mockup-fidelity is no longer constrained by Blocks primitives.
- `@devvit/public-api` (Blocks SDK) is **out**; `@devvit/web`, `@devvit/start`, and `hono` are **in**. Specs.md §5 tech stack updated.

Doc-sync per [14-Engineering.md §7.8](../14-Engineering.md) will land progressively as we touch each area doc — not blocking F-0.4 close.

## Alternatives Considered

- **Stay on Devvit Blocks.** Rejected: Reddit's current `npm create devvit@latest` no longer scaffolds Blocks; we'd have to manually wire the older SDK with no template support, fight against the platform's recommended path, and lose the build/deploy integration that comes for free with the Web template.
- **Eject from the scaffold and roll our own.** Rejected: the F-0.4 token is *the* mechanism by which the app is registered with the user's Reddit dev account. Walking away from the scaffold breaks that linkage and loses the deploy story.
- **Two separate apps (Blocks for UI, Web for API).** Rejected: doubles the surface area, fragments the trigger model, and gains nothing the single Web template doesn't already provide.

## Related

- [Specs.md §6](../Specs.md) — Devvit App Spec (needs sweep)
- [03-Devvit.md](../03-Devvit.md) — area doc (needs sweep)
- [09-UX.md §1.5](../09-UX.md) — "creative constraints" framing now obsolete
- [adr/0001-devvit-plus-external-backend.md](0001-devvit-plus-external-backend.md) — the higher-altitude split this ADR refines
- [`devvit-app/devvit.json`](../../devvit-app/devvit.json) — the live config
- [`devvit-app/src/index.ts`](../../devvit-app/src/index.ts) — the live entry point
