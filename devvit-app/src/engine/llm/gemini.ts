// Gemini REST client — direct HTTPS to generativelanguage.googleapis.com.
// On Devvit's global allowlist, no domain approval needed.

export type Role = 'reasoner' | 'summarizer';

export type Message = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmCompleteParams<T> = {
  role: Role;
  messages: Message[];
  responseSchema?: object | null;
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
  correlationId: string;
  thinkingBudget?: number | null;
  parseAs?: (text: string) => T;
};

export type LlmResponse<T = unknown> = {
  rawText: string;
  parsed: T | null;
  inputTokens: number;
  outputTokens: number;
  model: string;
  latencyMs: number;
  costUsd: number;
};

const MODEL_REASONER = 'gemini-2.5-pro';
const MODEL_SUMMARIZER = 'gemini-2.5-flash';

// $/1M tokens — ai.google.dev pricing.
const PRICE: Record<string, [number, number]> = {
  'gemini-2.5-pro': [1.25, 10.0],
  'gemini-2.5-flash': [0.075, 0.3],
};

function modelFor(role: Role): string {
  return role === 'reasoner' ? MODEL_REASONER : MODEL_SUMMARIZER;
}

function costUsd(model: string, inTok: number, outTok: number): number {
  const r = PRICE[model];
  if (!r) return 0;
  return (inTok * r[0] + outTok * r[1]) / 1_000_000;
}

type GeminiContent = { role: string; parts: { text: string }[] };

function splitMessages(messages: Message[]): {
  systemInstruction: string | null;
  contents: GeminiContent[];
} {
  const sys: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      sys.push(m.content);
    } else {
      contents.push({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }],
      });
    }
  }
  return {
    systemInstruction: sys.length > 0 ? sys.join('\n\n') : null,
    contents,
  };
}

type GeminiBody = {
  contents: GeminiContent[];
  generationConfig: Record<string, unknown>;
  systemInstruction?: { parts: { text: string }[] };
};

export class GeminiClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) throw new Error('GeminiClient: empty API key');
    this.apiKey = apiKey;
  }

  async complete<T = unknown>(params: LlmCompleteParams<T>): Promise<LlmResponse<T>> {
    const model = modelFor(params.role);
    const { systemInstruction, contents } = splitMessages(params.messages);

    const generationConfig: Record<string, unknown> = {
      temperature: params.temperature ?? 0,
      maxOutputTokens: params.maxTokens,
    };
    if (params.responseSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = params.responseSchema;
    }
    if (params.thinkingBudget != null) {
      generationConfig.thinkingConfig = { thinkingBudget: params.thinkingBudget };
    }

    const body: GeminiBody = { contents, generationConfig };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      this.apiKey,
    )}`;

    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), params.timeoutMs);
    const t0 = Date.now();
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(tid);
    }
    const latencyMs = Date.now() - t0;

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Gemini HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const data = (await resp.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const rawText =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    const cost = costUsd(model, inputTokens, outputTokens);

    let parsed: T | null = null;
    if (params.parseAs && rawText) {
      try {
        parsed = params.parseAs(rawText);
      } catch {
        parsed = null;
      }
    }

    return {
      rawText,
      parsed,
      inputTokens,
      outputTokens,
      model,
      latencyMs,
      costUsd: cost,
    };
  }
}
