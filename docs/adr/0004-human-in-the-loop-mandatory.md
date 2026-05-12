# ADR 0004: Human-in-the-Loop is Mandatory

Status: Accepted
Date: 2026-05-12

## Context

A class of moderation tools auto-fires actions — AutoMod removes comments by regex, classifier-based bots remove content above a score threshold. These tools fail visibly on harassment, brigading, and anything requiring judgment, but they also fail invisibly: a wrong autonomous action is a real harm to a real user, and there is no human in the loop to catch it.

ModPilot's product thesis is investigation, not classification. The system is built to surface context for the moderator's judgment, not to substitute for it.

## Decision

ModPilot never takes a moderation action autonomously. Every `Remove`, `Approve`, `Escalate`, and `Lock` requires an explicit moderator click.

This is invariant I-1 in [Specs.md](../Specs.md). It is enforced by:

- **No auto-fire code path.** The Devvit app has no function that calls the Reddit moderation API without a `ModAction` originating from a user click.
- **UI invariant.** Low-confidence verdicts (calibrated < 0.60) never style any action button as primary. See [09-UX.md §6](../09-UX.md).
- **Cold-start safety.** New installs run conservative until 50 feedback events accumulate; no primary-action prefill regardless of confidence. See [05-Memory.md](../05-Memory.md).
- **Documentation discipline.** Every PR that touches the trigger-to-action path is reviewed against this invariant.

The Reasoner *recommends*. The moderator *decides*.

## Consequences

- Moderator click-through is a required cost. We optimize the click-through with the Verdict Card UX — one-glance triage, visible evidence, honest uncertainty.
- We will *never* match the throughput of a fully-automated classifier. We do not aim to. ModPilot's value is in eliminating the investigation work, not the decision work.
- The product is auditable: every action in the system has a moderator's name on it.
- We can deploy in subreddits where autonomous action would be a non-starter for trust or compliance reasons.

## Alternatives Considered

- **Opt-in auto-fire for HIGH-confidence verdicts.** Rejected: invariant violations cascade. The moment any verdict can fire autonomously, the entire system is no longer human-in-the-loop, regardless of how rare the autonomous fires are.
- **Default-pending with timeout-fire.** Rejected: same problem. "Action fires unless the mod clicks Cancel within N seconds" is autonomous action with extra steps.
- **Confidence-gated auto-fire above 0.98.** Rejected: there is no calibration regime where 0.98 confidence equals zero false positives, and the cost of a false positive (a wrong removal) is high enough that the asymmetry never pencils out.

## Related

- [Specs.md §2 invariant I-1](../Specs.md)
- [01-Product.md](../01-Product.md) — non-goals
- [10-ReliabilityAndSafety.md](../10-ReliabilityAndSafety.md) — degradation never opens an autonomous path
- [09-UX.md §10](../09-UX.md) — action flow with mandatory click
