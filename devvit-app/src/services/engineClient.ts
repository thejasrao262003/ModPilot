// Devvit → Engine HTTP client (S-1.2).
//
// Spec: docs/Specs.md §10, docs/03-Devvit.md, docs/06-AILayer.md.
//
// Signs POST /investigate requests with HMAC-SHA256 per the engine's
// middleware contract (engine/api/middleware.py):
//   X-Modpilot-Signature  = hex(HMAC-SHA256(secret, `${ts}.${body}`))
//   X-Modpilot-Timestamp  = unix seconds (5-min skew tolerated)
//   X-Correlation-Id      = stable id; engine echoes back
//
// Uses the Web Crypto API (works in Devvit Web's Node runtime + any
// future Workers-style sandbox). Avoids `node:crypto` to stay portable.

import { ENGINE_SHARED_SECRET, ENGINE_URL } from './engineConfig.local';

/** Wire request shape — must mirror engine/api/schemas.py InvestigateRequest. */
export type InvestigateRequest = {
  correlation_id: string;
  subreddit_id: string;
  target: {
    kind: 'comment' | 'post';
    id: string;
    body: string;
    author: string;
  };
  report: {
    reasons: string[];
    reporter_count: number;
    first_at?: string | null;
    last_at?: string | null;
  };
  context?: {
    thread_id?: string;
    thread_excerpts?: string[];
  };
};

export type EvidenceRow = {
  id: string;
  summary: string;
  tool: string;
};

export type ConfidenceBreakdown = {
  llm_self_report: number;
  evidence_convergence: number;
  subreddit_accuracy: number;
  rule_match_strength: number;
};

export type Verdict = {
  correlation_id: string;
  tier: 'FAST' | 'STANDARD' | 'DEEP';
  risk_tier: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendation: 'REMOVE' | 'APPROVE' | 'ESCALATE' | 'LOCK' | 'NO_RECOMMENDATION';
  calibrated_confidence: number;
  rationale: string;
  top_evidence: EvidenceRow[];
  timeline: Array<{
    tool: string;
    verb: string;
    status: 'success' | 'failure' | 'skipped' | 'timeout';
    latency_ms: number;
    evidence_ids: string[];
  }>;
  confidence_breakdown: ConfidenceBreakdown;
  model_reasoner: string;
  model_summarizer: string;
  cost_usd: number;
  latency_ms: number;
  validation_flag: boolean;
  degraded: boolean;
  cold_start: boolean;
};

export type EngineResult =
  | { ok: true; verdict: Verdict; latency_ms: number }
  | { ok: false; code: string; message: string; retryable: boolean; latency_ms: number };

const HEADER_SIGNATURE = 'x-modpilot-signature';
const HEADER_TIMESTAMP = 'x-modpilot-timestamp';
const HEADER_CORRELATION = 'x-correlation-id';

/** Sign + POST /investigate. Soft fail — returns { ok: false } envelope on error. */
export async function callInvestigate(req: InvestigateRequest, timeoutMs = 8_000): Promise<EngineResult> {
  const t0 = Date.now();
  const url = `${ENGINE_URL.replace(/\/$/, '')}/investigate`;
  const body = JSON.stringify(req);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await hmacHex(ENGINE_SHARED_SECRET, `${timestamp}.${body}`);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        [HEADER_SIGNATURE]: signature,
        [HEADER_TIMESTAMP]: timestamp,
        [HEADER_CORRELATION]: req.correlation_id,
      },
      body,
    });
    const elapsed = Date.now() - t0;

    const parsed = (await safeJson(res)) as Record<string, unknown> | null;
    if (!res.ok) {
      const err = (parsed?.error ?? {}) as { code?: string; message?: string; retryable?: boolean };
      return {
        ok: false,
        code: err.code ?? `HTTP_${res.status}`,
        message: err.message ?? res.statusText ?? 'engine error',
        retryable: Boolean(err.retryable),
        latency_ms: elapsed,
      };
    }
    if (!parsed?.ok || !parsed.data) {
      return {
        ok: false,
        code: 'INVALID_ENVELOPE',
        message: 'engine returned non-envelope response',
        retryable: false,
        latency_ms: elapsed,
      };
    }
    return { ok: true, verdict: parsed.data as Verdict, latency_ms: elapsed };
  } catch (err) {
    const elapsed = Date.now() - t0;
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      ok: false,
      code: ac.signal.aborted ? 'TIMEOUT' : 'NETWORK',
      message: msg,
      retryable: true,
      latency_ms: elapsed,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** HMAC-SHA256, hex-encoded — matches engine/api/middleware.py. */
async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const bytes = new Uint8Array(sigBuf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}
