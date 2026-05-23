// Reasoner prompt + caller. Mirrors engine/llm/prompts/reasoner.py.
// Spec: docs/06-AILayer.md §4.2, docs/Specs.md §7.5.

import type { EvidenceAccumulator } from '../accumulator';
import type { EvidenceEntry, Recommendation, RiskTier } from '../types';
import type { GeminiClient, Message } from './gemini';

export type ReasonerOutput = {
  risk_tier: RiskTier;
  recommendation: Recommendation;
  rationale: string;
  top_evidence_ids: string[];
  raw_confidence: number;
  cited_evidence_ids: string[];
  flags: string[];
  // Short bulleted findings about the CONTENT itself (Stage 1 conclusions).
  // Each item is a brief checkmark-style finding — "✓ Respectful criticism",
  // "✓ No direct hate detected", "⚠ Borderline phrasing on line 2", etc.
  // These render in the moderator's "Current Content Assessment" panel and
  // are how the Reasoner exposes its Stage 1 content judgment as discrete
  // findings rather than buried in prose. May be empty for degraded paths.
  content_findings: string[];
};

export type ReasonerResult = {
  output: ReasonerOutput;
  rawText: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
};

const SYSTEM_PROMPT = `You are ModPilot's investigation Reasoner. Your role is to produce a moderation recommendation for a Reddit moderator based on accumulated evidence from an investigation.

You do not take actions. You make recommendations. The moderator decides.

═══════════════════════════════════════════════════════════════
CRITICAL MODERATION PRINCIPLE — READ THIS FIRST
═══════════════════════════════════════════════════════════════

None of the following are evidence that the current content violates
a rule:

  • Prior violations / prior removals / repeat-offender status
  • Moderator history / account age / reputation
  • Reporter count / report velocity / number of people who flagged it
  • Previous investigations on the same author

Bad users can make compliant posts.
Good users can make violating posts.
A widely-reported post can still be compliant (brigading exists).
A single-reported post can still be a clear violation.

Judge the content first. History and reports are context for the
*response severity* and *moderator attention level*, never primary
evidence of guilt.

═══════════════════════════════════════════════════════════════
TWO-STAGE REASONING — STRUCTURE YOUR THINKING THIS WAY
═══════════════════════════════════════════════════════════════

STAGE 1 — Content Assessment (the rule question)

Inputs you may use: the reported content, the active subreddit rules,
the thread context. Nothing else.

Ask yourself: "If this exact content were posted by a brand-new user
with no history at all, would it violate the rules?"

Possible answers:
  • Clear violation — content directly breaks a configured rule
  • Borderline — language toes the line but isn't an explicit violation
  • Compliant — content does not violate any configured rule

STAGE 2 — Action Assessment (the response question)

Only after Stage 1 finds a violation may history influence severity:
  • Repeat offender + clear violation → REMOVE with high confidence
  • First-time offender + clear violation → REMOVE with explanation tone
  • Positive history + borderline → APPROVE or NO_RECOMMENDATION
  • Repeat offender + compliant content → APPROVE — history doesn't
    convert compliant content into a violation

═══════════════════════════════════════════════════════════════
RESPECT TEST — BINDING RULES, NOT JUST EXAMPLES
═══════════════════════════════════════════════════════════════

Respect does NOT require agreement. Performance criticism IS allowed.
Character attacks are NOT, and override any "performance critique"
framing.

ALLOWED (performance / tactical / selection critique):
  "Kohli's form has declined."
  "Dhoni should retire."
  "Rohit made poor tactical decisions."
  "Rahul should be dropped from the squad."
  "I disagree with the captaincy choice."
  "His batting average has dropped this season."
These can be sharp, they can be wrong, they can hurt feelings. They
are still allowed. Recommend APPROVE.

NOT ALLOWED — direct character attacks on a player or user. If the
content says "[person] is [insulting predicate]" or equivalent, it is
a clear violation of "respect for players" / "no hate" / "no personal
attacks" rules. This is BINDING — recommend REMOVE.

The following predicates ARE disrespect when applied to a person:
  is a clown / is a joke / is pathetic / is useless / is garbage /
  is trash / is a fraud / is a loser / is an idiot / is a moron /
  is stupid / is brain-dead / is washed / is finished as a human
  being, ...and equivalents in any language.

CONCRETE CASES (memorize these):
  "Rohit is a clown."        → REMOVE. Character attack. Stage 1 violation.
  "Kohli is useless."        → REMOVE. Character attack. Stage 1 violation.
  "Dhoni is pathetic."       → REMOVE. Character attack. Stage 1 violation.
  "Rahul is a joke."         → REMOVE. Character attack. Stage 1 violation.
  "Rohit made bad calls."    → APPROVE. Performance critique.
  "Kohli's form is poor."    → APPROVE. Performance critique.

A direct insult applied to a named player cannot be reclassified as
"opinion" or "discussion". Saying "I just think he's a clown" does
not soften "is a clown" — the predicate remains a character attack.

Likewise for users: "you're an idiot", "you're brain-dead" → REMOVE.

═══════════════════════════════════════════════════════════════
QUOTE DETECTION
═══════════════════════════════════════════════════════════════

Distinguish endorsement from discussion. Quoting criticism to push
back on it is not itself a violation.

APPROVE: "People keep saying Kohli is finished. I disagree completely."
REMOVE:  "Kohli is finished."

If the author is discussing, quoting, or rebutting a viewpoint rather
than endorsing it, factor that into Stage 1.

═══════════════════════════════════════════════════════════════
OUTPUT CONSTRAINTS
═══════════════════════════════════════════════════════════════

1. CITATION CONTRACT. Every factual claim in your rationale must cite
   an evidence ID [ev-N] from the Evidence Block. Unsupported claims
   fail validation. NEVER invent ev-N ids that don't appear in the
   Evidence Block.

2. NO INVENTED FACTS. Reason only from evidence in the Evidence Block
   plus the reported content + rules shown in the user message. If
   evidence is insufficient or contradictory, say so and recommend
   NO_RECOMMENDATION with appropriately low confidence.

3. PERSONALITY-AWARE THRESHOLD. The subreddit's moderation personality
   shifts the *threshold* for recommending action, never the content
   judgment:
   • Strict: lower threshold for removal once Stage 1 finds a violation
   • Balanced: weigh evidence fairly
   • Lenient: higher threshold; give benefit of the doubt on borderline

4. CALIBRATED CONFIDENCE. Report raw_confidence in [0.0, 1.0]. Honest
   uncertainty preferred over false certainty. If Stage 1 found a
   clear violation, you may be confident. If Stage 1 was borderline
   and you're leaning on history, your confidence MUST be lower.

5. RISK TIER. Assign HIGH / MEDIUM / LOW based on Stage 1's content
   judgment + Stage 2's history weighting.

6. RATIONALE STRUCTURE. Lead with the content judgment (Stage 1),
   then layer in history (Stage 2). Do NOT lead with "the user has N
   prior removals" — that's anchoring bias. Lead with what the
   content does or doesn't do.

7. CONTENT FINDINGS. In addition to the rationale, produce
   \`content_findings\`: 2-5 short checkmark-style bullets summarizing
   your STAGE 1 content judgment. Format each as "✓ ..." for findings
   that support compliance, "⚠ ..." for borderline observations, or
   "✗ ..." for findings that support removal. These are about the
   CONTENT only — never about the author's history, prior removals,
   or report count. Examples:
     "✓ Respectful criticism — performance critique, not insult"
     "✓ No direct hate detected"
     "✓ Author quoting/discussing rather than endorsing"
     "⚠ Borderline language on one sentence"
     "✗ Direct insult: 'is useless' violates Respect Test"
     "✗ Matches Rule 3 keywords + dehumanizing framing"
   Findings must be visible in the reported content. Do NOT include
   "first-time user", "0 prior violations", "1 prior removal", or any
   author-metadata observation — those belong to Moderator Memory,
   not Content Assessment.

Your output must conform to the provided JSON schema. No prose outside it.`;

function serializeEvidence(entries: EvidenceEntry[]): string {
  if (entries.length === 0) return '(no evidence collected)';
  return entries
    .map((e) => {
      const detail = Object.entries(e.detail)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${stringifyDetail(v)}`)
        .join(', ');
      return `[${e.id}] ${e.tool}: ${e.summary}${detail ? ` (${detail})` : ''}`;
    })
    .join('\n');
}

function stringifyDetail(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export function buildMessages(args: {
  accumulator: EvidenceAccumulator;
  personality: string;
  personalityPhrasing: string;
  region: string;
  rules: string;
  targetKind: string;
  targetId: string;
  /** Post title — distinct from body. For comments, leave empty. */
  targetTitle?: string;
  targetBody: string;
  targetAuthor: string;
  reporterCount: number;
  tier: string;
  toolsRun: number;
  isPartial: boolean;
  coldStart: boolean;
}): Message[] {
  const allEntries = args.accumulator.successfulEntries();
  // Partition evidence into:
  //   Stage 1 (content): rule_match + thread_context — about the post itself
  //   Stage 2 (context): user_history + prior_actions + report_velocity —
  //     about the author OR community reaction, NOT about whether a rule
  //     was broken. report_velocity is "many people reported this", which
  //     is community attention, not evidence of violation.
  const contentEntries = allEntries.filter(
    (e) => e.tool === 'policy_match' || e.tool === 'thread_context',
  );
  const contextEntries = allEntries.filter(
    (e) =>
      e.tool === 'user_history' ||
      e.tool === 'prior_actions' ||
      e.tool === 'report_velocity',
  );
  const contentBlock = serializeEvidence(contentEntries);
  const contextBlock = serializeEvidence(contextEntries);

  // Cap body to keep token cost bounded. Title shown separately and
  // labeled so the Reasoner cannot miss the headline (where character
  // attacks frequently live, e.g. "Rohit is a clown" with a mild body).
  const titleText = (args.targetTitle ?? '').slice(0, 280);
  const body = (args.targetBody ?? '').slice(0, 800);
  const renderedContent = (() => {
    if (args.targetKind === 'comment') return body || '(empty body)';
    const parts = [];
    if (titleText) parts.push(`TITLE: ${titleText}`);
    parts.push(`BODY: ${body || '(empty body)'}`);
    return parts.join('\n');
  })();

  const user =
    `## Subreddit Context\n` +
    `Personality: ${args.personality}\n` +
    `Personality guidance: ${args.personalityPhrasing || '(default)'}\n` +
    `Region: ${args.region}\n` +
    `Active rules:\n${args.rules.trim() ? args.rules : '(no rules configured)'}\n\n` +
    `═══════════════════════════════════════════════════════════════\n` +
    `STAGE 1 — Content Assessment\n` +
    `═══════════════════════════════════════════════════════════════\n` +
    `Use ONLY the inputs in this section. History below is for Stage 2.\n\n` +
    `## Reported content\n` +
    `Target: ${args.targetKind} ${args.targetId}\n` +
    `Author: ${args.targetAuthor || '(unknown)'}\n\n` +
    `${renderedContent}\n\n` +
    `Important: judge the WHOLE content — title AND body for posts. The\n` +
    `headline is part of what the author published. A post whose title is\n` +
    `a direct character attack ("X is a clown") violates the Respect Test\n` +
    `regardless of how mild the body sounds.\n\n` +
    `## Content-derived evidence (rule match, thread context)\n` +
    `${contentBlock}\n\n` +
    `Question for Stage 1: If this exact content were posted by a brand-new\n` +
    `user with NO history and NO reports yet, would it violate the active\n` +
    `rules above?\n` +
    `Apply the Respect Test and Quote Detection. Form your content judgment\n` +
    `BEFORE looking at Stage 2's context.\n\n` +
    `═══════════════════════════════════════════════════════════════\n` +
    `STAGE 2 — Action Assessment\n` +
    `═══════════════════════════════════════════════════════════════\n` +
    `Use this section to calibrate the *response severity*, not to\n` +
    `manufacture a violation. If Stage 1 found compliant content, Stage 2\n` +
    `cannot override that — recommend APPROVE.\n\n` +
    `IMPORTANT: Reporter count and report velocity are NOT evidence of\n` +
    `violation. Many people can report compliant content (brigading,\n` +
    `coordinated false reports, popular-but-controversial takes). High\n` +
    `report counts mean the community is paying attention — they justify\n` +
    `running a *deeper* investigation, but they do not by themselves make\n` +
    `compliant content into a violation. Same for prior removals on the\n` +
    `author: those raise the priority of *looking carefully*, not the\n` +
    `probability that this post breaks a rule.\n\n` +
    `## Community + author context\n` +
    `Reporter count on this post: ${args.reporterCount}\n` +
    `${contextBlock}\n\n` +
    `═══════════════════════════════════════════════════════════════\n` +
    `## Investigation State\n` +
    `Tier: ${args.tier}\n` +
    `Tools run: ${args.toolsRun}\n` +
    `Partial investigation: ${args.isPartial}\n` +
    `Cold-start: ${args.coldStart}\n\n` +
    `Produce your recommendation as a JSON object conforming to the schema.\n` +
    `Rationale must cite at least one real [ev-N] from the blocks above.\n` +
    `Lead the rationale with your Stage 1 content judgment, then layer\n` +
    `Stage 2's history weighting. Never lead with "the user has N prior\n` +
    `removals" — that's the anchoring bias we explicitly forbid.`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

export function buildCorrectiveMessages(args: {
  priorMessages: Message[];
  priorResponse: string;
  reason: string;
  details: string;
}): Message[] {
  const corrective =
    `\n\n## Validation Error\n\nYour previous response failed citation validation:\n` +
    `Reason: ${args.reason}\nDetails: ${args.details}\n\n` +
    `Fix the issues and produce a corrected JSON response. Ensure every factual claim ` +
    `in the rationale cites an evidence ID from the Evidence Block, and that all cited ` +
    `IDs appear in the Evidence Block.`;
  return [
    ...args.priorMessages,
    { role: 'assistant', content: args.priorResponse },
    { role: 'user', content: corrective },
  ];
}

const REASONER_SCHEMA = {
  type: 'object',
  properties: {
    risk_tier: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
    recommendation: {
      type: 'string',
      enum: ['REMOVE', 'APPROVE', 'ESCALATE', 'LOCK', 'NO_RECOMMENDATION'],
    },
    rationale: { type: 'string' },
    top_evidence_ids: { type: 'array', items: { type: 'string' } },
    raw_confidence: { type: 'number' },
    cited_evidence_ids: { type: 'array', items: { type: 'string' } },
    flags: { type: 'array', items: { type: 'string' } },
    content_findings: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'risk_tier',
    'recommendation',
    'rationale',
    'top_evidence_ids',
    'raw_confidence',
    'cited_evidence_ids',
    'content_findings',
  ],
};

function parseReasoner(text: string): ReasonerOutput {
  const obj = JSON.parse(text) as ReasonerOutput;
  if (!Array.isArray(obj.flags)) obj.flags = [];
  if (!Array.isArray(obj.content_findings)) obj.content_findings = [];
  return obj;
}

export class Reasoner {
  static MAX_TOKENS = 1024;
  static TIMEOUT_MS = 15_000;
  static TEMPERATURE = 0.0;
  static THINKING_BUDGET = 512;

  constructor(private readonly llm: GeminiClient) {}

  async reason(args: { messages: Message[]; correlationId: string }): Promise<ReasonerResult> {
    // Dump the exact prompt being sent to Gemini. This is verbose but
    // invaluable when debugging "why didn't the Reasoner recommend X?".
    // Each message is logged separately so role + content read cleanly
    // in the playtest terminal.
    console.log('reasoner.prompt.start', {
      correlation_id: args.correlationId,
      message_count: args.messages.length,
    });
    for (const m of args.messages) {
      console.log(`reasoner.prompt.${m.role}`, '\n' + m.content);
    }
    console.log('reasoner.prompt.end', { correlation_id: args.correlationId });

    const resp = await this.llm.complete({
      role: 'reasoner',
      messages: args.messages,
      responseSchema: REASONER_SCHEMA,
      maxTokens: Reasoner.MAX_TOKENS,
      temperature: Reasoner.TEMPERATURE,
      timeoutMs: Reasoner.TIMEOUT_MS,
      correlationId: args.correlationId,
      thinkingBudget: Reasoner.THINKING_BUDGET,
      parseAs: parseReasoner,
    });
    const output = resp.parsed ?? parseReasoner(resp.rawText);
    console.log('reasoner.response', {
      correlation_id: args.correlationId,
      risk_tier: output.risk_tier,
      recommendation: output.recommendation,
      raw_confidence: output.raw_confidence,
      cited_evidence_ids: output.cited_evidence_ids,
      rationale: output.rationale,
      flags: output.flags,
      input_tokens: resp.inputTokens,
      output_tokens: resp.outputTokens,
      cost_usd: resp.costUsd,
      latency_ms: resp.latencyMs,
    });
    return {
      output,
      rawText: resp.rawText,
      model: resp.model,
      inputTokens: resp.inputTokens,
      outputTokens: resp.outputTokens,
      costUsd: resp.costUsd,
      latencyMs: resp.latencyMs,
    };
  }
}
