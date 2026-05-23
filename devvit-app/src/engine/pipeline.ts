// Investigation pipeline — Strategy → Orchestrator → Reasoner → Validator → Calibrator.
// Mirrors engine/api/pipeline.py:run_investigation, ported to in-process Devvit.

import { EvidenceAccumulator, ToolRegistry } from './accumulator';
import { calibrate, computeEvidenceConvergence } from './calibrator';
import { GeminiClient } from './llm/gemini';
import {
  Reasoner,
  buildCorrectiveMessages,
  buildMessages,
  type ReasonerOutput,
  type ReasonerResult,
} from './llm/reasoner';
import { validateCitations } from './llm/validator';
import { Orchestrator } from './loop';
import { getPreset } from './personalities';
import { selectStrategy, type StrategyInputs } from './strategy';
import { ensureSubredditProfile } from './store/subreddit';
import { getThreadMemory } from './store/threadMemory';
import { getUserMemory } from './store/userMemory';
import { persistInvestigation } from './store/investigation';
import { bumpInvestigationStats, readAlignmentSnapshot } from './store/stats';
import { computeRuleMatch } from './ruleMatch';
import { computePriority, priorityHeadline } from './priority';
import {
  buildRuleMatchDisplay,
  deriveAuthorSignal,
  deriveConfidenceFactors,
  deriveKeyFactors,
} from './explainability';
import { deriveEscalation } from './escalation';
import { ReportVelocityTool } from './tools/reportVelocity';
import { UserHistoryTool } from './tools/userHistory';
import { PriorActionsTool } from './tools/priorActions';
import { ThreadContextTool } from './tools/threadContext';
import type {
  Recommendation,
  RiskTier,
  ToolContext,
  ToolName,
  Verdict,
} from './types';

export type InvestigateInput = {
  correlationId: string;
  subredditId: string;
  target: {
    kind: 'comment' | 'post';
    id: string;
    // For posts: the headline string. Distinct from body — the title is
    // where character attacks like "Rohit is a clown" usually live, and
    // the Reasoner must see it to judge the content correctly. Comments
    // have no separate title.
    title: string;
    body: string;
    author: string;
  };
  reporterCount: number;
  threadId?: string;
  threadExcerpts?: string[];
};

const TOOL_VERBS: Record<ToolName, string> = {
  policy_match: 'Matched against rules',
  report_velocity: 'Checked report velocity',
  user_history: 'Pulled author history',
  prior_actions: 'Reviewed prior mod actions',
  thread_context: 'Read thread context',
};

export async function runInvestigation(args: {
  input: InvestigateInput;
  geminiApiKey: string;
}): Promise<Verdict> {
  const t0 = Date.now();
  const llm = new GeminiClient(args.geminiApiKey);

  // Registry — tools that need the LLM get it at construction.
  const registry = new ToolRegistry();
  registry.register(new ReportVelocityTool());
  registry.register(new UserHistoryTool());
  registry.register(new PriorActionsTool());
  registry.register(new ThreadContextTool(llm));

  // Guard: subreddit_id is load-bearing — every persisted key includes it.
  // Falling back to a literal string would silently route reads to the wrong
  // hash and yield "no rules configured" even after a successful save.
  if (!args.input.subredditId || !args.input.subredditId.startsWith('t5_')) {
    throw new Error(
      `runInvestigation: missing or malformed subreddit_id (${args.input.subredditId}). ` +
        'Caller must pass context.subredditId.',
    );
  }

  // Pull subreddit + user + thread state.
  const [profile, userMem, threadMem] = await Promise.all([
    ensureSubredditProfile(args.input.subredditId),
    getUserMemory(args.input.subredditId, args.input.target.author),
    args.input.threadId
      ? getThreadMemory(args.input.subredditId, args.input.threadId)
      : Promise.resolve(null),
  ]);

  console.log('engine.profile_loaded', {
    correlation_id: args.input.correlationId,
    sub_id: args.input.subredditId,
    personality: profile.personality,
    region: profile.region,
    rules_chars: profile.rules.length,
    rules_preview: profile.rules.slice(0, 120),
    tier_override: profile.tierOverride,
    cold_start_count: profile.coldStartCount,
  });
  // Lowered cold-start threshold — original 50 is fine for a long-lived sub
  // but too punitive for fresh demos. After 10 investigations the sub has
  // enough history that demoting confidence by 0.85 stops being honest.
  const coldStart = profile.coldStartCount < 10;
  const userRiskTier = userMem?.riskTier ?? 'new';
  const threadEscalated = threadMem
    ? threadMem.modActionsTaken > 0 || threadMem.escalationTurn !== null
    : false;

  // For posts, the title often carries the actual content judgment ("Rohit
  // is a clown" lives in the title; the body might be milder). The Reasoner
  // sees both; the rule-match precheck scans both. Comments have no title.
  const titlePlusBody = [args.input.target.title, args.input.target.body]
    .filter(Boolean)
    .join('\n')
    .trim();

  // 0. Rule-match precheck. Substring score over content words across configured
  //    rules. Feeds Strategy Selector + Calibrator and is appended as a real
  //    evidence row so the Reasoner can cite it.
  const ruleMatch = computeRuleMatch(titlePlusBody, profile.rules);
  console.log('engine.rule_match', {
    correlation_id: args.input.correlationId,
    score: ruleMatch.score,
    matched_rule: ruleMatch.matchedRule,
    matched_terms: ruleMatch.matchedTerms,
  });

  // 1. Strategy
  const strategyInputs: StrategyInputs = {
    reporterCount: args.input.reporterCount,
    velocityZscore: 0, // computed by tool; pre-pipeline cheap signal stub
    userRiskTier,
    ruleMatchScore: ruleMatch.score,
    personality: profile.personality,
    tierOverride: profile.tierOverride,
    coldStart,
    threadEscalated,
  };
  const decision = selectStrategy(strategyInputs);

  // 2. Orchestrator
  const context: ToolContext = {
    subredditId: args.input.subredditId,
    correlationId: args.input.correlationId,
    targetKind: args.input.target.kind,
    targetId: args.input.target.id,
    targetBody: args.input.target.body,
    targetAuthorId: args.input.target.author,
    reporterCount: args.input.reporterCount,
    ruleMatchScore: ruleMatch.score,
    threadId: args.input.threadId ?? '',
    threadExcerpts: args.input.threadExcerpts ?? [],
  };
  const orchResult = await new Orchestrator(registry).run({ decision, context });
  const acc = orchResult.accumulator;

  // 2b. Append rule-match as a synthetic evidence row when the score is
  //     meaningful, so the Reasoner can cite [ev-N] for the content match
  //     instead of inventing a slot. signal: 'high' lets it influence
  //     evidence convergence + earlier stop conditions.
  if (ruleMatch.score >= 0.2 && ruleMatch.matchedRule) {
    acc.append({
      tool: 'policy_match',
      status: 'success',
      summary: `Content matches "${ruleMatch.matchedRule.slice(0, 80)}" (${Math.round(
        ruleMatch.score * 100,
      )}% term overlap)`,
      latencyMs: 1,
      detail: {
        matched_rule: ruleMatch.matchedRule,
        matched_terms: ruleMatch.matchedTerms,
        matches: [{ similarity: ruleMatch.score }],
        signal: ruleMatch.score >= 0.5 ? 'high' : 'normal',
      },
    });
  }

  // 3. Reasoner (with validate + retry)
  const isPartial =
    orchResult.earlyStopped && orchResult.stopReason !== 'converged';
  const preset = getPreset(profile.personality);
  const messages = buildMessages({
    accumulator: acc,
    personality: profile.personality,
    personalityPhrasing: preset.promptPhrasing,
    region: profile.region,
    rules: profile.rules,
    targetKind: args.input.target.kind,
    targetId: args.input.target.id,
    targetTitle: args.input.target.title,
    targetBody: args.input.target.body,
    targetAuthor: args.input.target.author,
    reporterCount: args.input.reporterCount,
    tier: decision.tier,
    toolsRun: orchResult.toolsRun,
    isPartial,
    coldStart,
  });

  let reasonerResult: ReasonerResult | null = null;
  let validationFlag = false;

  if (decision.reasonerRequired) {
    reasonerResult = await reasonWithRetry({
      reasoner: new Reasoner(llm),
      messages,
      accumulator: acc,
      correlationId: args.input.correlationId,
    });
    validationFlag = reasonerResult === null;
  }

  const reasonerOutput: ReasonerOutput = reasonerResult?.output ?? fallbackOutput();

  // 4. Calibrate
  const ruleMatchStrength = extractRuleMatchStrength(acc);
  const signals = extractEvidenceSignals(acc);
  const cal = calibrate({
    llmSelfReport: reasonerOutput.raw_confidence,
    evidenceConvergence: computeEvidenceConvergence(signals),
    subredditAccuracy: 0.5,
    ruleMatchStrength,
    validationPassed: !validationFlag,
    coldStart,
    isPartial,
    recommendation: reasonerOutput.recommendation,
  });

  // 4b. Deterministic explainability surfaces (Features 1, 2, 4, 5, 6, 7, 8).
  //     Read existing signals + alignment snapshot in parallel — no extra LLM.
  const priorRemovalsFromInv = extractPriorRemovalsCount(acc);
  const escalation = deriveEscalation(acc);

  const authorSignal = deriveAuthorSignal({
    priorViolations: userMem?.priorViolations ?? 0,
    priorApprovals: userMem?.priorApprovals ?? 0,
    hasHistory: userMem !== null,
    priorRemovalsFromInvestigations: priorRemovalsFromInv,
  });

  const policyEvidenceId =
    acc.successfulEntries().find((e) => e.tool === 'policy_match')?.id ?? null;
  const ruleMatches = buildRuleMatchDisplay({
    match: ruleMatch,
    ruleMatchEvidenceId: policyEvidenceId,
  });

  const reasonerForKey = reasonerResult?.output ?? reasonerOutput;
  const confidenceFactors = deriveConfidenceFactors({
    calibratedConfidence: cal.calibratedConfidence,
    breakdown: {
      llmSelfReport: cal.llmSelfReport,
      evidenceConvergence: cal.evidenceConvergence,
      subredditAccuracy: cal.subredditAccuracy,
      ruleMatchStrength: cal.ruleMatchStrength,
    },
    validationPassed: !validationFlag,
    isPartial,
    coldStart,
    ruleMatchScore: ruleMatch.score,
    escalationLevel: escalation.level,
    authorSignal,
    recommendation: reasonerOutput.recommendation,
  });

  const keyFactors = deriveKeyFactors({
    ruleMatchScore: ruleMatch.score,
    authorSignal,
    velocityZscore: 0, // velocity z is computed inside tools; surface via evidence convergence instead
    reporterCount: args.input.reporterCount,
    escalationLevel: escalation.level,
    evidenceConvergence: cal.evidenceConvergence,
    priorRemovals: priorRemovalsFromInv,
    recommendation: reasonerForKey.recommendation,
  });

  const priority = computePriority({
    calibratedConfidence: cal.calibratedConfidence,
    reporterCount: args.input.reporterCount,
    velocityZscore: extractVelocityZscore(acc),
    userRiskTier: (userMem?.riskTier ?? userRiskTier) as 'new' | 'trusted' | 'neutral' | 'watched',
    priorRemovals: priorRemovalsFromInv,
    escalationLevel: escalation.level,
    ruleMatchScore: ruleMatch.score,
    recommendation: reasonerForKey.recommendation,
  });

  const alignmentSnapshot = await readAlignmentSnapshot(args.input.subredditId).catch(() => ({
    rate: null as number | null,
    total: 0,
    aligned: 0,
  }));

  // 5. Assemble verdict
  const totalMs = Date.now() - t0;
  const verdict: Verdict = {
    correlationId: args.input.correlationId,
    tier: decision.tier,
    riskTier: reasonerOutput.risk_tier,
    recommendation: reasonerOutput.recommendation,
    calibratedConfidence: cal.calibratedConfidence,
    rationale: reasonerOutput.rationale,
    topEvidence: reasonerOutput.top_evidence_ids
      .map((id) => acc.byId(id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
      .slice(0, 3)
      .map((e) => ({ id: e.id, summary: e.summary, tool: e.tool })),
    timeline: acc.entries().map((e) => ({
      tool: e.tool,
      verb: TOOL_VERBS[e.tool as ToolName] ?? `Ran ${e.tool}`,
      status: e.status,
      latencyMs: e.latencyMs,
      evidenceIds: [e.id],
    })),
    confidenceBreakdown: {
      llmSelfReport: cal.llmSelfReport,
      evidenceConvergence: cal.evidenceConvergence,
      subredditAccuracy: cal.subredditAccuracy,
      ruleMatchStrength: cal.ruleMatchStrength,
    },
    modelReasoner: reasonerResult?.model ?? '',
    modelSummarizer: '',
    costUsd: round6(reasonerResult?.costUsd ?? 0),
    latencyMs: totalMs,
    validationFlag,
    degraded: reasonerResult === null,
    coldStart,
    priority: {
      score: priority.score,
      bucket: priority.bucket,
      headline: priorityHeadline(priority.bucket),
      drivers: priority.drivers,
    },
    authorSignal,
    escalation,
    confidenceFactors,
    keyFactors,
    ruleMatches,
    alignment: {
      rate: alignmentSnapshot.rate,
      sampleSize: alignmentSnapshot.total,
      aligned: alignmentSnapshot.aligned,
    },
    contentFindings: Array.isArray(reasonerOutput.content_findings)
      ? reasonerOutput.content_findings.slice(0, 6)
      : [],
  };

  // 6. Persist (best-effort; investigation row used by prior_actions next time).
  try {
    await persistInvestigation({
      subId: args.input.subredditId,
      authorId: args.input.target.author,
      targetId: args.input.target.id,
      targetKind: args.input.target.kind,
      targetBody: args.input.target.body,
      verdict,
    });
  } catch (e) {
    console.warn('engine.persist_failed', {
      correlation_id: verdict.correlationId,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  // 7. Bump subreddit-level stats counters. Best-effort.
  try {
    await bumpInvestigationStats(args.input.subredditId, verdict);
  } catch (e) {
    console.warn('engine.stats_bump_failed', {
      correlation_id: verdict.correlationId,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  return verdict;
}

async function reasonWithRetry(args: {
  reasoner: Reasoner;
  messages: Parameters<Reasoner['reason']>[0]['messages'];
  accumulator: EvidenceAccumulator;
  correlationId: string;
}): Promise<ReasonerResult | null> {
  let first: ReasonerResult | null = null;
  try {
    first = await args.reasoner.reason({
      messages: args.messages,
      correlationId: args.correlationId,
    });
  } catch (e) {
    console.warn('reasoner.failed', { attempt: 1, err: errMsg(e) });
    return null;
  }

  const v1 = validateCitations(
    first.output.rationale,
    args.accumulator,
    first.output.cited_evidence_ids,
  );
  if (v1.passed) return first;
  console.warn('reasoner.validation_failed', { attempt: 1, reason: v1.reason });

  const corrective = buildCorrectiveMessages({
    priorMessages: args.messages,
    priorResponse: first.rawText,
    reason: v1.reason,
    details: JSON.stringify(v1.details),
  });

  try {
    const second = await args.reasoner.reason({
      messages: corrective,
      correlationId: `${args.correlationId}:retry`,
    });
    const v2 = validateCitations(
      second.output.rationale,
      args.accumulator,
      second.output.cited_evidence_ids,
    );
    if (v2.passed) return second;
    console.warn('reasoner.validation_failed', { attempt: 2, reason: v2.reason });
    return null;
  } catch (e) {
    console.warn('reasoner.failed', { attempt: 2, err: errMsg(e) });
    return null;
  }
}

function fallbackOutput(): ReasonerOutput {
  return {
    risk_tier: 'LOW' as RiskTier,
    recommendation: 'NO_RECOMMENDATION' as Recommendation,
    rationale:
      'ModPilot was unable to produce a recommendation for this report. The evidence has been collected and is available for review [ev-1].',
    top_evidence_ids: ['ev-1'],
    raw_confidence: 0,
    cited_evidence_ids: ['ev-1'],
    flags: ['reasoner_failed'],
    content_findings: [],
  };
}

function extractPriorRemovalsCount(acc: EvidenceAccumulator): number {
  const entry = acc.successfulEntries().find((e) => e.tool === 'prior_actions');
  if (!entry) return 0;
  const removals = entry.detail.removals;
  return typeof removals === 'number' ? removals : 0;
}

function extractVelocityZscore(acc: EvidenceAccumulator): number {
  const entry = acc.successfulEntries().find((e) => e.tool === 'report_velocity');
  if (!entry) return 0;
  const z = entry.detail.z_score;
  return typeof z === 'number' ? z : 0;
}

function extractRuleMatchStrength(acc: EvidenceAccumulator): number {
  for (const e of acc.successfulEntries()) {
    if (e.tool === 'policy_match') {
      const matches = e.detail.matches;
      if (Array.isArray(matches) && matches.length > 0) {
        const first = matches[0];
        if (first && typeof first === 'object' && 'similarity' in first) {
          const sim = (first as { similarity?: unknown }).similarity;
          return typeof sim === 'number' ? sim : 0;
        }
      }
    }
  }
  return 0;
}

function extractEvidenceSignals(acc: EvidenceAccumulator): number[] {
  const out: number[] = [];
  for (const e of acc.successfulEntries()) {
    if (e.tool === 'policy_match') {
      const m = e.detail.matches;
      if (Array.isArray(m) && m.length > 0 && m[0] && typeof m[0] === 'object') {
        const sim = (m[0] as { similarity?: unknown }).similarity;
        out.push(typeof sim === 'number' ? sim : 0);
      } else {
        out.push(0);
      }
    } else if (e.tool === 'report_velocity') {
      const z = e.detail.z_score;
      const zn = typeof z === 'number' ? z : 0;
      out.push(Math.min(Math.abs(zn) / 5, 1));
    } else {
      out.push(0.5);
    }
  }
  return out;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
