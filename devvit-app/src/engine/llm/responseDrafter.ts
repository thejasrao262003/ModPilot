// Moderator Response Drafter (FEATURE 9). Gemini 2.5 Flash, thinking disabled.
//
// Generates a draft moderator-facing reply to the target's author. The mod
// optionally provides freeform guidance ("don't penalize this time", "explain
// Rule 3", etc.) — the draft is shown for review/edit before sending.
//
// Invariants preserved:
//   • Never auto-sends — the caller must explicitly invoke the send endpoint.
//   • Draft only references rules/evidence already in the verdict's context.
//   • Tone calibrated to the subreddit's personality preset.

import type { GeminiClient, Message } from './gemini';
import type { Recommendation } from '../types';

export type DraftKind = 'REMOVE' | 'APPROVE_WITH_WARNING' | 'WARNING' | 'ESCALATE';

export type DraftInputs = {
  rules: string;
  personality: 'strict' | 'balanced' | 'lenient';
  recommendation: Recommendation;
  modAction: 'REMOVE' | 'APPROVE' | 'LOCK' | 'ESCALATE';
  rationale: string;            // Reasoner's rationale, already cited
  evidenceSummary: string[];    // top_evidence lines (already cited in rationale)
  matchedRules: string[];       // from rule_matches display
  moderatorInstructions: string; // freeform mod guidance, optional
  targetAuthor: string;
};

export type DraftResult = {
  kind: DraftKind;
  subject: string;       // short subject line for modmail or PM
  body: string;          // full body — moderator can edit before sending
  costUsd: number;
  latencyMs: number;
  model: string;
};

const SYSTEM_PROMPT = `You draft a moderator-to-user message for a Reddit moderation tool. The moderator has already made a decision; your job is to communicate that decision to the post/comment's author clearly and respectfully.

Hard constraints:
1. Plain English. No legalese, no "hereby", no "the moderation team has determined".
2. Reference the specific rule when applicable; do not invent rules.
3. Stay neutral and respectful even when the action is REMOVE. Never accuse, lecture, or shame.
4. Match the subreddit's moderation posture: strict (firm, clear), balanced (neutral, informative), lenient (warm, give benefit of doubt).
5. Honor the moderator's freeform instructions when provided.
6. Use second-person ("your post" / "your comment"), not third-person.
7. Output exactly the JSON schema. No surrounding prose.

The output is a DRAFT. The moderator will review and edit before sending. Do not write disclaimers like "this is a draft" or "moderator may edit".

Length: 60-160 words.`;

const SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['REMOVE', 'APPROVE_WITH_WARNING', 'WARNING', 'ESCALATE'],
    },
    subject: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['kind', 'subject', 'body'],
};

function pickKind(modAction: DraftInputs['modAction']): DraftKind {
  if (modAction === 'REMOVE') return 'REMOVE';
  if (modAction === 'ESCALATE') return 'ESCALATE';
  if (modAction === 'LOCK') return 'WARNING';
  // APPROVE — when the moderator approves an item that ModPilot recommended
  // removing, frame as approve-with-warning; otherwise straight warning.
  return 'APPROVE_WITH_WARNING';
}

function buildUserPrompt(inp: DraftInputs): string {
  const k = pickKind(inp.modAction);
  const rulesBlock = inp.rules.trim() || '(no rules configured)';
  const evidenceBlock = inp.evidenceSummary.length
    ? inp.evidenceSummary.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '(no evidence rows surfaced)';
  const matchedBlock = inp.matchedRules.length ? inp.matchedRules.join('\n') : '(no specific rule matched)';
  const instructionBlock = inp.moderatorInstructions.trim()
    ? inp.moderatorInstructions.trim()
    : '(moderator did not provide additional guidance)';

  return `## Subreddit personality
${inp.personality}

## Subreddit rules (reference; cite by rule number when applicable)
${rulesBlock}

## What the moderator decided
Action: ${inp.modAction}
ModPilot's recommendation was: ${inp.recommendation}
Draft kind: ${k}
Target author: u/${inp.targetAuthor || '(unknown)'}

## ModPilot's rationale
${inp.rationale}

## Evidence rows (already cited in rationale)
${evidenceBlock}

## Rules potentially matched
${matchedBlock}

## Moderator's freeform instructions
${instructionBlock}

## Task
Produce a JSON object matching the schema. \`kind\` must be ${k}. \`subject\` is a 4-10 word headline. \`body\` is the message text — 60-160 words. Refer to the specific rule when applicable. Match the personality.`;
}

function parseDraft(text: string): DraftResult {
  const obj = JSON.parse(text) as { kind?: string; subject?: string; body?: string };
  return {
    kind: (obj.kind as DraftKind) ?? 'WARNING',
    subject: typeof obj.subject === 'string' ? obj.subject : 'Note about your post',
    body: typeof obj.body === 'string' ? obj.body : '',
    costUsd: 0,
    latencyMs: 0,
    model: 'gemini-2.5-flash',
  };
}

export class ResponseDrafter {
  static MAX_TOKENS = 512;
  static TIMEOUT_MS = 8000;
  static TEMPERATURE = 0.4; // slight variation reads more human
  static THINKING_BUDGET = 0;

  constructor(private readonly llm: GeminiClient) {}

  async draft(inp: DraftInputs, correlationId: string): Promise<DraftResult> {
    const messages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(inp) },
    ];
    console.log('responseDrafter.prompt', {
      correlation_id: correlationId,
      mod_action: inp.modAction,
      kind: pickKind(inp.modAction),
      personality: inp.personality,
      instructions_chars: inp.moderatorInstructions.length,
    });

    const resp = await this.llm.complete({
      role: 'summarizer', // use Flash pricing/model
      messages,
      responseSchema: SCHEMA,
      maxTokens: ResponseDrafter.MAX_TOKENS,
      temperature: ResponseDrafter.TEMPERATURE,
      timeoutMs: ResponseDrafter.TIMEOUT_MS,
      correlationId,
      thinkingBudget: ResponseDrafter.THINKING_BUDGET,
      parseAs: parseDraft,
    });

    const parsed = resp.parsed ?? parseDraft(resp.rawText);
    const out: DraftResult = {
      ...parsed,
      costUsd: resp.costUsd,
      latencyMs: resp.latencyMs,
      model: resp.model,
    };
    console.log('responseDrafter.response', {
      correlation_id: correlationId,
      kind: out.kind,
      subject: out.subject,
      body_chars: out.body.length,
      cost_usd: out.costUsd,
      latency_ms: out.latencyMs,
    });
    return out;
  }
}
