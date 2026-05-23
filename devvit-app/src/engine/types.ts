// Shared types for the in-Devvit investigation engine.
// Mirrors engine/orchestrator/tools.py + engine/api/schemas.py + engine/orchestrator/strategy.py.
// ADR-0007: the Python engine remains the reference implementation; this is the demo path.

export type ToolName =
  | 'policy_match'
  | 'report_velocity'
  | 'user_history'
  | 'prior_actions'
  | 'thread_context';

export type ToolStatus = 'success' | 'failure' | 'skipped' | 'timeout';

export type Personality = 'strict' | 'balanced' | 'lenient';
export type TierOverride = 'auto' | 'fast' | 'standard' | 'deep';
export type UserRiskTier = 'new' | 'trusted' | 'neutral' | 'watched';
export type StrategyTier = 'FAST' | 'STANDARD' | 'DEEP';
export type RiskTier = 'HIGH' | 'MEDIUM' | 'LOW';
export type Recommendation =
  | 'REMOVE'
  | 'APPROVE'
  | 'ESCALATE'
  | 'LOCK'
  | 'NO_RECOMMENDATION';

export type ToolContext = {
  subredditId: string;
  correlationId: string;
  targetKind: 'comment' | 'post';
  targetId: string;
  targetBody: string;
  targetAuthorId: string;
  reporterCount: number;
  ruleMatchScore: number;
  threadId: string;
  threadExcerpts: string[];
};

export type ToolResult = {
  tool: ToolName;
  status: ToolStatus;
  summary: string;
  latencyMs: number;
  detail: Record<string, unknown>;
  error?: string;
};

export type EvidenceEntry = {
  id: string; // "ev-N"
  tool: ToolName;
  status: ToolStatus;
  summary: string;
  detail: Record<string, unknown>;
  latencyMs: number;
  error?: string;
};

export type EvidenceRow = {
  id: string;
  summary: string;
  tool: ToolName | string;
};

export type TimelineStep = {
  tool: ToolName | string;
  verb: string;
  status: ToolStatus;
  latencyMs: number;
  evidenceIds: string[];
};

export type ConfidenceBreakdown = {
  llmSelfReport: number;
  evidenceConvergence: number;
  subredditAccuracy: number;
  ruleMatchStrength: number;
};

export type Verdict = {
  correlationId: string;
  tier: StrategyTier;
  riskTier: RiskTier;
  recommendation: Recommendation;
  calibratedConfidence: number;
  rationale: string;
  topEvidence: EvidenceRow[];
  timeline: TimelineStep[];
  confidenceBreakdown: ConfidenceBreakdown;
  modelReasoner: string;
  modelSummarizer: string;
  costUsd: number;
  latencyMs: number;
  validationFlag: boolean;
  degraded: boolean;
  coldStart: boolean;
  // ── Explainability + priority surfaces (Features 1–8). All deterministic;
  //    none drive the recommendation or calibrated confidence.
  priority: {
    score: number;
    bucket: 'urgent' | 'review_soon' | 'low_risk';
    headline: string;
    drivers: { label: string; weight: number }[];
  };
  authorSignal: {
    kind: 'repeat' | 'first_time' | 'positive' | 'neutral';
    headline: string;
    detail: string;
    badge: string;
  };
  escalation: {
    level: 'none' | 'mild' | 'moderate' | 'high';
    headline: string | null;
    summary: string | null;
    evidenceId: string | null;
  };
  confidenceFactors: { direction: 'up' | 'down'; reason: string }[];
  keyFactors: {
    label: string;
    impact: 'high' | 'medium' | 'low';
    direction: 'positive' | 'negative' | 'neutral';
  }[];
  ruleMatches: {
    rule: string;
    score: 'high' | 'medium' | 'low';
    evidenceIds: string[];
  }[];
  alignment: {
    rate: number | null;      // null until ≥5 feedback samples accumulate
    sampleSize: number;
    aligned: number;
  };
};

export interface Tool {
  readonly name: ToolName;
  run(context: ToolContext): Promise<ToolResult>;
}
