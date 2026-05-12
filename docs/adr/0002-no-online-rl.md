# ADR 0002: No Online Reinforcement Learning

Status: Accepted
Date: 2026-05-12

## Context

The conceptual lineage of ModPilot's investigation architecture is multi-step reasoning research that includes reinforcement-learning framing (action spaces, observation spaces, policy gradients, reward signals). The temptation is to carry that mechanism forward — train a policy online from moderator feedback, optimize against an alignment-rate reward, learn tool-selection strategies.

We are not doing that.

## Decision

No online RL training. No reward function. No policy gradient updates from production traffic.

Adaptation happens through three explicit, auditable mechanisms instead:

1. **Subreddit personality presets** (Strict / Balanced / Lenient) — chosen by the moderator during the wizard, editable in settings. Affects confidence thresholds and prompt context.
2. **Confidence Calibration weights** — a per-subreddit blend over four calibration inputs (LLM self-report, evidence convergence, subreddit accuracy, rule-match strength). Updated nightly from feedback, never online.
3. **Cold-start mode** — first 50 feedback events run with conservative thresholds and no primary-action prefill.

The internal architecture borrows useful primitives (Tool Registry, Evidence Accumulator, Investigation Timeline) but treats them as observable, deterministic engineering — not as components of a learning loop.

## Consequences

- Behavior is predictable and auditable: every recommendation is traceable to evidence + prompt + calibration, not to an opaque updated policy.
- Banned terminology (`policy`, `reward`, `episode`, `agent`, `trajectory`) stays out of user-facing surfaces. See [Glossary.md](../Glossary.md).
- We trade some theoretical adaptiveness for moderator trust. Moderators can answer "why did ModPilot recommend this?" by reading the Investigation Timeline. They could not answer it under an online-RL system.
- Compliance and review become tractable. An auditable system is a deployable system.

## Alternatives Considered

- **Online RL on tool selection.** Rejected: opaque adaptation undermines trust; production traffic isn't a clean training signal; banned terminology leaks into product.
- **Offline fine-tuning of the Reasoner.** Rejected for MVP: operational cost (hosting fine-tuned weights, eval drift) exceeds prompt-engineering ROI at hackathon scale. May revisit post-MVP via ADR.
- **Bandit-style tool selection.** Rejected: same opacity concerns; the Strategy Selector's heuristic is faster, cheaper, and explainable.

## Related

- [Specs.md §1.3](../Specs.md) — non-goals
- [05-Memory.md](../05-Memory.md) — what adaptation we *do* have
- [Glossary.md](../Glossary.md) — banned terminology
