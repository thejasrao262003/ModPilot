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

CRITICAL CONSTRAINTS:

1. CITATION CONTRACT. Every factual claim in your rationale must cite an evidence ID in the format [ev-N], where N matches an evidence row provided in the Evidence Block. Unsupported claims are bugs and will fail validation.

2. NO INVENTED FACTS. You may only reason from evidence that appears in the Evidence Block. If evidence is insufficient or contradictory, say so and recommend NO_RECOMMENDATION with appropriately low confidence.

3. NO IDENTITIES. The Evidence Block uses anonymized references. Use those references in your rationale. Do not invent usernames or real-world identities.

4. PERSONALITY-AWARE. The subreddit's moderation personality affects when to recommend action versus no action:
   - Strict: lower threshold for removal, prioritize community safety.
   - Balanced: weigh evidence fairly, recommend action only with clear signals.
   - Lenient: higher threshold for removal, give benefit of the doubt.

5. CALIBRATED CONFIDENCE. Report raw_confidence in [0.0, 1.0]. This number will be combined with other signals downstream — it is not the final confidence shown to the moderator. Be honest. Low confidence is preferred over false certainty.

6. RISK TIER. Assign HIGH / MEDIUM / LOW based on the severity of the potential violation and strength of evidence:
   - HIGH: clear violation with strong corroborating evidence.
   - MEDIUM: probable violation but evidence is mixed or incomplete.
   - LOW: unlikely violation, or evidence is too weak to act on.

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
  targetBody: string;
  targetAuthor: string;
  reporterCount: number;
  tier: string;
  toolsRun: number;
  isPartial: boolean;
  coldStart: boolean;
}): Message[] {
  const block = serializeEvidence(args.accumulator.successfulEntries());
  // Cap body to keep token cost bounded. The Reasoner doesn't need the
  // whole long-form post — first ~800 chars carry the signal in 99% of
  // moderation cases.
  const body = (args.targetBody ?? '').slice(0, 800);
  const user =
    `## Subreddit Context\n` +
    `Personality: ${args.personality}\n` +
    `Personality guidance: ${args.personalityPhrasing || '(default)'}\n` +
    `Region: ${args.region}\n` +
    `Active rules:\n${args.rules.trim() ? args.rules : '(no rules configured)'}\n\n` +
    `## Report Summary\n` +
    `Target: ${args.targetKind} ${args.targetId}\n` +
    `Author: ${args.targetAuthor || '(unknown)'}\n` +
    `Reporter count: ${args.reporterCount}\n\n` +
    `## Reported content\n` +
    `${body || '(empty body)'}\n\n` +
    `Read the content above carefully. Your recommendation must consider whether ` +
    `the content itself violates the active rules — not only the tool evidence. ` +
    `If the content clearly violates a rule:\n` +
    ` - recommend REMOVE\n` +
    ` - quote the violating phrase in your rationale and reference the rule number (e.g. "Rule 2")\n` +
    ` - cite at least one real evidence id from the Evidence Block below (e.g. user_history or prior_actions) to anchor the citation\n` +
    `Do NOT invent evidence ids like [ev-1] that don't appear in the Evidence Block. ` +
    `If you genuinely lack signal, recommend NO_RECOMMENDATION.\n\n` +
    `## Evidence Block\n${block}\n\n` +
    `## Investigation State\n` +
    `Tier: ${args.tier}\n` +
    `Tools run: ${args.toolsRun}\n` +
    `Partial investigation: ${args.isPartial}\n` +
    `Cold-start: ${args.coldStart}\n\n` +
    `Produce your recommendation as a JSON object conforming to the schema.`;
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
  },
  required: [
    'risk_tier',
    'recommendation',
    'rationale',
    'top_evidence_ids',
    'raw_confidence',
    'cited_evidence_ids',
  ],
};

function parseReasoner(text: string): ReasonerOutput {
  const obj = JSON.parse(text) as ReasonerOutput;
  if (!Array.isArray(obj.flags)) obj.flags = [];
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
