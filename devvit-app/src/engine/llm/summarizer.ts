// Thread Summarizer — Gemini 2.5 Flash, structured output, thinking disabled.
// Mirrors engine/llm/prompts/summarizer.py.

import type { GeminiClient, Message } from './gemini';

export type ThreadSummary = {
  arc: string;
  escalation_turn: number | null;
  instigator_candidates: string[];
  off_topic: boolean;
  total_turns: number;
};

export type SummarizerResult = {
  summary: ThreadSummary;
  rawText: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
};

const SYSTEM_PROMPT = `You summarize a Reddit thread for a moderator. Output exactly the JSON schema requested — no prose, no markdown, no preamble.

Field guidance:
- arc: one short sentence describing the conversation's shape. Examples: "civil debate that stays on topic", "Q&A that becomes a roast", "back-and-forth that escalates to personal attacks at turn 8".
- escalation_turn: the 0-indexed comment number where tone shifts toward hostility, harassment, or rule violation. Null if no escalation.
- instigator_candidates: usernames who appear to drive escalation. Empty list if no clear instigators.
- off_topic: true if the thread substantially drifts from the original post's subject.
- total_turns: total number of comments provided.

Be conservative. Prefer null/empty over guessing. Do not invent usernames or escalation that isn't visible in the excerpts.`;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    arc: { type: 'string' },
    escalation_turn: { type: ['integer', 'null'] },
    instigator_candidates: { type: 'array', items: { type: 'string' } },
    off_topic: { type: 'boolean' },
    total_turns: { type: 'integer' },
  },
  required: ['arc', 'instigator_candidates', 'off_topic', 'total_turns'],
};

function buildMessages(postBody: string, comments: string[]): Message[] {
  const turns = comments.map((c, i) => `[turn ${i}] ${c}`).join('\n');
  const user =
    `POST BODY:\n${postBody || '(empty)'}\n\n` +
    `COMMENT EXCERPTS:\n${turns || '(no comments provided)'}\n\n` +
    `Summarize this thread per the JSON schema. total_turns must equal ${comments.length}.`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

function parseSummary(text: string): ThreadSummary {
  const obj = JSON.parse(text) as ThreadSummary;
  if (!Array.isArray(obj.instigator_candidates)) obj.instigator_candidates = [];
  if (obj.escalation_turn === undefined) obj.escalation_turn = null;
  return obj;
}

export class Summarizer {
  static MAX_TOKENS = 512;
  static TIMEOUT_MS = 5_000;
  static TEMPERATURE = 0.0;
  static THINKING_BUDGET = 0; // Flash supports disabling thinking.

  constructor(private readonly llm: GeminiClient) {}

  async summarize(args: {
    postBody: string;
    comments: string[];
    correlationId: string;
  }): Promise<SummarizerResult> {
    const messages = buildMessages(args.postBody, args.comments);
    const resp = await this.llm.complete({
      role: 'summarizer',
      messages,
      responseSchema: SUMMARY_SCHEMA,
      maxTokens: Summarizer.MAX_TOKENS,
      temperature: Summarizer.TEMPERATURE,
      timeoutMs: Summarizer.TIMEOUT_MS,
      correlationId: args.correlationId,
      thinkingBudget: Summarizer.THINKING_BUDGET,
      parseAs: parseSummary,
    });
    const summary = resp.parsed ?? parseSummary(resp.rawText);
    return {
      summary,
      rawText: resp.rawText,
      model: resp.model,
      inputTokens: resp.inputTokens,
      outputTokens: resp.outputTokens,
      costUsd: resp.costUsd,
      latencyMs: resp.latencyMs,
    };
  }
}
