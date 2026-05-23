// ModPilot Verdict UI — vanilla ES module, no framework.
// Fetches /api/verdict/canned (Devvit-side, returns same shape as engine's
// /investigate canned verdict per docs/Specs.md §10.2) and renders the
// Verdict Card + Investigation Timeline. Honest-uncertainty UX kicks in
// when calibrated_confidence < 0.60 per docs/09-UX.md §6.

const TOOL_VERB = {
  policy_match: 'Matched against rules',
  report_velocity: 'Checked report velocity',
  user_history: 'Pulled author history',
  prior_actions: 'Reviewed prior mod actions',
  thread_context: 'Read thread context',
};

const RISK_PILL_LABEL = {
  HIGH: 'High risk',
  MEDIUM: 'Medium',
  LOW: 'Low conf.',
};

const TIER_INDICATOR = {
  HIGH: '▲ High tier',
  MEDIUM: '● Medium tier',
  LOW: '▼ Low tier',
};

const STATUS_GLYPH = { success: '✓', failure: '✗', skipped: '⊘', timeout: '⏱' };

const ACTIONS = ['Remove', 'Approve', 'Escalate', 'Lock'];

// Render the "recommend Remove." style title with bold action.
function titleFor(verdict) {
  const r = verdict.recommendation;
  if (r === 'NO_RECOMMENDATION') {
    return `<em>ModPilot is unsure —</em><br/><strong>your call.</strong>`;
  }
  const word = { REMOVE: 'Remove', APPROVE: 'Approve', ESCALATE: 'Escalate', LOCK: 'Lock' }[r];
  const verb = verdict.calibrated_confidence >= 0.80 ? 'Recommend' : 'Suggest';
  return `${verb} <strong>${word}.</strong>`;
}

function targetLine(verdict, target) {
  const kind = target?.kind === 'post' ? 'Post' : 'Comment';
  const id = target?.id ?? '—';
  const reports = target?.report_count ?? '';
  const reportsLabel = reports ? ` · ${reports} report${reports === 1 ? '' : 's'}` : '';
  return `${kind} · <span class="id">${id}</span>${reportsLabel}`;
}

function renderEvidence(rows) {
  const ul = document.getElementById('evidence');
  ul.innerHTML = '';
  rows.forEach((row, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="marker">${String(i + 1).padStart(2, '0')}</span>
      <span class="claim">${escapeHtml(row.summary)}</span>
      <a class="ev-chip" data-link="${row.id}">${row.id.replace('-', '·')}</a>
    `;
    ul.appendChild(li);
  });
}

function renderActions(verdict) {
  const bar = document.getElementById('actions');
  bar.innerHTML = '';
  const isLow = verdict.calibrated_confidence < 0.60;
  const isColdStart = verdict.cold_start;
  const isHigh = verdict.calibrated_confidence >= 0.80;
  const primaryFor = { REMOVE: 'Remove', APPROVE: 'Approve', ESCALATE: 'Escalate', LOCK: 'Lock' }[verdict.recommendation];

  ACTIONS.forEach((label) => {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = label;
    // Per docs/09-UX.md §4.4: primary styling only for HIGH-conf, non-cold-start verdicts.
    if (!isLow && !isColdStart && isHigh && label === primaryFor) {
      btn.classList.add('is-primary');
      if (verdict.risk_tier === 'HIGH') btn.classList.add('high');
      if (verdict.risk_tier === 'MEDIUM') btn.classList.add('medium');
    }
    btn.addEventListener('click', () => onAction(label, verdict));
    bar.appendChild(btn);
  });
}

function renderTimeline(verdict) {
  const list = document.getElementById('tl-list');
  list.innerHTML = '';
  verdict.timeline.forEach((step) => {
    const li = document.createElement('li');
    li.className = 'tl-row';
    li.innerHTML = `
      <span class="tl-icon" data-status="${step.status}">${STATUS_GLYPH[step.status] ?? '?'}</span>
      <span class="tl-action">${escapeHtml(step.verb)}</span>
      <span class="tl-latency">${step.latency_ms} ms</span>
      <span class="tl-evs">${step.evidence_ids.map((id) => `<a class="ev-chip" data-link="${id}">${id.replace('-', '·')}</a>`).join('')}</span>
    `;
    list.appendChild(li);
  });

  // Rationale with citation chips inlined where [ev-N] appears.
  const rationale = document.getElementById('vb-rationale');
  rationale.innerHTML = escapeHtml(verdict.rationale).replace(
    /\[(ev-\d+)\]/g,
    (_m, id) => `<a class="ev-chip" data-link="${id}">${id.replace('-', '·')}</a>`,
  );

  const cost = verdict.cost_usd.toFixed(3);
  const tokens = `${verdict.input_tokens ?? '—'} in / ${verdict.output_tokens ?? '—'} out`;
  document.getElementById('vb-model').innerHTML =
    `<strong>${escapeHtml(verdict.model_reasoner)}</strong> · ${tokens} · $${cost}`;

  document.getElementById('timeline-aside').textContent = `Expanded from card · I`;
  document.getElementById('timeline-label').innerHTML =
    `${verdict.timeline.length} lookups, <em>${(verdict.latency_ms / 1000).toFixed(1)} seconds</em>`;
  document.getElementById('timeline-stats').innerHTML =
    `Total · <strong>$${cost}</strong> · ${verdict.timeline.length} tools · ${verdict.timeline.filter((s) => s.status !== 'success').length} failures`;

  // Confidence breakdown.
  document.getElementById('vb-conf-pct').textContent = `${Math.round(verdict.calibrated_confidence * 100)}%`;
  const breakdown = verdict.confidence_breakdown;
  const labels = {
    llm_self_report: 'LLM self-report',
    evidence_convergence: 'Evidence convergence',
    subreddit_accuracy: 'Sub accuracy (30d)',
    rule_match_strength: 'Rule-match strength',
  };
  const list2 = document.getElementById('vb-conf-list');
  list2.innerHTML = '';
  Object.entries(labels).forEach(([key, label]) => {
    const v = breakdown[key];
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="name">${label}</span>
      <span class="bar"><span style="width: ${Math.round(v * 100)}%"></span></span>
      <span class="val">${v.toFixed(2)}</span>
    `;
    list2.appendChild(li);
  });
}

function bindEvidenceLinking() {
  document.querySelectorAll('.ev-chip[data-link]').forEach((chip) => {
    chip.addEventListener('mouseenter', () => {
      const id = chip.dataset.link;
      document.querySelectorAll(`.ev-chip[data-link="${id}"]`).forEach((c) => c.classList.add('is-active'));
    });
    chip.addEventListener('mouseleave', () => {
      document.querySelectorAll('.ev-chip').forEach((c) => c.classList.remove('is-active'));
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Feature 1: priority pill in the header ──────────────────────────────
function renderPriorityPill(priority) {
  const el = document.getElementById('priority-pill');
  if (!priority || typeof priority.score !== 'number') return;
  el.hidden = false;
  el.dataset.bucket = priority.bucket || 'low_risk';
  el.textContent = `${priority.headline || 'ℹ️ Low Risk'} · ${priority.score}`;
}

// ── Feature 5: escalation banner ─────────────────────────────────────────
function renderEscalationBanner(escalation) {
  const el = document.getElementById('escalation-banner');
  if (!escalation || !escalation.headline || escalation.level === 'none') return;
  el.hidden = false;
  el.dataset.level = escalation.level;
  const summary = escalation.summary ? `<span class="esc-summary"> — ${escapeHtml(escalation.summary)}</span>` : '';
  el.innerHTML = `<strong>${escapeHtml(escalation.headline)}</strong>${summary}`;
}

// ── Features 2 + 7: author signal (repeat / first-time / positive) ──────
function renderAuthorSignal(signal) {
  const el = document.getElementById('author-signal');
  if (!signal || !signal.headline) return;
  el.hidden = false;
  el.dataset.kind = signal.kind || 'neutral';
  el.innerHTML = `
    <span class="as-headline">${escapeHtml(signal.headline)}</span>
    <span class="as-detail">${escapeHtml(signal.detail || '')}</span>
  `;
}

// ── Feature 4: confidence explanation panel ─────────────────────────────
function renderConfidenceFactors(factors) {
  const list = document.getElementById('conf-factors-list');
  if (!Array.isArray(factors) || factors.length === 0) return;
  document.getElementById('confidence-explain-section').hidden = false;
  list.innerHTML = '';
  for (const f of factors) {
    const li = document.createElement('li');
    li.className = `cf-row cf-${f.direction === 'up' ? 'up' : 'down'}`;
    const arrow = f.direction === 'up' ? '▲ increased' : '▼ reduced';
    li.innerHTML = `<span class="cf-arrow">${arrow}</span><span class="cf-reason">${escapeHtml(f.reason)}</span>`;
    list.appendChild(li);
  }
}

// ── Feature 8: key factors panel ────────────────────────────────────────
function renderKeyFactors(factors) {
  const list = document.getElementById('key-factors-list');
  if (!Array.isArray(factors) || factors.length === 0) return;
  document.getElementById('key-factors-section').hidden = false;
  list.innerHTML = '';
  for (const f of factors) {
    const li = document.createElement('li');
    li.className = `kf-row kf-${f.impact} kf-${f.direction}`;
    li.innerHTML = `
      <span class="kf-impact">${f.impact.toUpperCase()}</span>
      <span class="kf-label">${escapeHtml(f.label)}</span>
    `;
    list.appendChild(li);
  }
}

// ── Feature 6: rule match explainability ────────────────────────────────
function renderRuleMatches(matches) {
  const list = document.getElementById('rule-matches-list');
  if (!Array.isArray(matches) || matches.length === 0) return;
  document.getElementById('rule-matches-section').hidden = false;
  list.innerHTML = '';
  for (const m of matches) {
    const li = document.createElement('li');
    li.className = `rm-row rm-${m.score}`;
    const evChips = (Array.isArray(m.evidenceIds) ? m.evidenceIds : [])
      .map((id) => `<a class="ev-chip" data-link="${escapeHtml(id)}">${escapeHtml(id.replace('-', '·'))}</a>`)
      .join(' ');
    li.innerHTML = `
      <div class="rm-head">
        <span class="rm-rule">${escapeHtml(m.rule)}</span>
        <span class="rm-score">Score: ${m.score}</span>
      </div>
      <div class="rm-evidence">${evChips || '<span class="rm-noev">no cited evidence rows</span>'}</div>
    `;
    list.appendChild(li);
  }
}

// ── Feature 3: alignment line in footer ─────────────────────────────────
function renderAlignmentLine(alignment) {
  const el = document.getElementById('alignment-line');
  if (!alignment || typeof alignment.sampleSize !== 'number') return;
  if (alignment.rate === null || alignment.rate === undefined) return;
  const pct = Math.round(alignment.rate * 100);
  el.hidden = false;
  el.textContent = `ModPilot and your mod team agree ${pct}% of the time (${alignment.aligned}/${alignment.sampleSize} mod actions).`;
}

// ── Feature 9 ─────────────────────────────────────────────────────────
// Click an action button → open the Response modal (mod can skip, generate
// a draft, edit it, and decide whether to actually send a reply).
function onAction(label, verdict) {
  openResponseModal(label, verdict);
}

async function postFeedback(label, verdict) {
  const res = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlation_id: verdict.correlation_id,
      mod_action: label.toUpperCase(),
      recommendation: verdict.recommendation,
      source: 'verdict_card',
      target_id: verdict.target_id || verdict.target?.id || '',
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body.data;
}

async function postDraft(label, verdict, instructions) {
  const res = await fetch('/api/draft-response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlation_id: verdict.correlation_id,
      mod_action: label.toUpperCase(),
      moderator_instructions: instructions || '',
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body.data;
}

async function postSendReply(verdict, draftBody) {
  const res = await fetch('/api/send-response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlation_id: verdict.correlation_id,
      target_id: verdict.target_id || verdict.target?.id || '',
      body: draftBody,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body.data;
}

let _modalState = null;

function openResponseModal(label, verdict) {
  _modalState = { label, verdict };
  const modal = document.getElementById('response-modal');
  modal.hidden = false;
  document.getElementById('rm-action-headline').textContent = `${label} · draft a response (optional)`;
  document.getElementById('rm-instructions').value = '';
  document.getElementById('rm-step-instructions').hidden = false;
  document.getElementById('rm-step-draft').hidden = true;
  document.getElementById('rm-status').hidden = true;
}

function closeResponseModal() {
  const modal = document.getElementById('response-modal');
  modal.hidden = true;
  _modalState = null;
}

function setModalStatus(text, kind) {
  const el = document.getElementById('rm-status');
  el.hidden = false;
  el.textContent = text;
  el.dataset.kind = kind || 'pending';
}

function wireResponseModal() {
  document.getElementById('rm-close')?.addEventListener('click', closeResponseModal);

  document.getElementById('rm-skip')?.addEventListener('click', async () => {
    if (!_modalState) return;
    const { label, verdict } = _modalState;
    setModalStatus(`Recording ${label.toLowerCase()}…`, 'pending');
    try {
      const data = await postFeedback(label, verdict);
      const aligned = data.aligned === 'true';
      setModalStatus(
        aligned
          ? `${label} applied · aligned with ModPilot ✓`
          : `${label} applied · you overrode ModPilot's ${verdict.recommendation.toLowerCase()}`,
        'success',
      );
      disableActionButtons();
      setTimeout(closeResponseModal, 1500);
    } catch (err) {
      setModalStatus(`Failed: ${String(err)}`, 'error');
    }
  });

  document.getElementById('rm-generate')?.addEventListener('click', () => generateDraft());
  document.getElementById('rm-regenerate')?.addEventListener('click', () => generateDraft());

  document.getElementById('rm-act-only')?.addEventListener('click', async () => {
    if (!_modalState) return;
    const { label, verdict } = _modalState;
    setModalStatus(`Taking action without sending reply…`, 'pending');
    try {
      await postFeedback(label, verdict);
      setModalStatus(`${label} applied · no reply sent`, 'success');
      disableActionButtons();
      setTimeout(closeResponseModal, 1500);
    } catch (err) {
      setModalStatus(`Failed: ${String(err)}`, 'error');
    }
  });

  document.getElementById('rm-send')?.addEventListener('click', async () => {
    if (!_modalState) return;
    const { label, verdict } = _modalState;
    const body = document.getElementById('rm-body').value.trim();
    if (!body) {
      setModalStatus('Draft is empty. Add text before sending.', 'error');
      return;
    }
    setModalStatus(`Taking action and sending reply…`, 'pending');
    try {
      await postFeedback(label, verdict);
      const sendData = await postSendReply(verdict, body);
      setModalStatus(`${label} applied · reply sent (${sendData.reply_id})`, 'success');
      disableActionButtons();
      setTimeout(closeResponseModal, 2000);
    } catch (err) {
      setModalStatus(`Send failed: ${String(err)}`, 'error');
    }
  });
}

async function generateDraft() {
  if (!_modalState) return;
  const { label, verdict } = _modalState;
  const instructions = document.getElementById('rm-instructions').value;
  setModalStatus('Generating draft…', 'pending');
  try {
    const draft = await postDraft(label, verdict, instructions);
    document.getElementById('rm-subject').value = draft.subject || '';
    document.getElementById('rm-body').value = draft.body || '';
    document.getElementById('rm-step-instructions').hidden = true;
    document.getElementById('rm-step-draft').hidden = false;
    setModalStatus(`Draft ready (${draft.model || 'gemini'} · $${(draft.costUsd || 0).toFixed(4)}) — edit before sending.`, 'success');
  } catch (err) {
    setModalStatus(`Draft generation failed: ${String(err)}`, 'error');
  }
}

function disableActionButtons() {
  document.querySelectorAll('#actions .btn').forEach((b) => { b.disabled = true; });
}

function ensureStatusEl() {
  let el = document.getElementById('action-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'action-status';
    el.className = 'action-status';
    document.getElementById('actions').insertAdjacentElement('afterend', el);
  }
  return el;
}

async function load() {
  const root = document.getElementById('root');
  try {
    // /api/verdict (no params) — server resolves correlation_id from
    // context.postId → post_correlation:{postId} Redis mapping that
    // menu.ts writes when it creates the custom post.
    const res = await fetch('/api/verdict', {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error?.message ?? 'unknown error');
    render(body.data, body.target);
    root.dataset.state = 'ready';
  } catch (err) {
    console.error('modpilot.load.failed', err);
    document.getElementById('loading-state').hidden = true;
    document.getElementById('error-state').hidden = false;
    document.getElementById('retry-btn').addEventListener('click', () => location.reload());
    root.dataset.state = 'error';
  }
}

function render(verdict, target) {
  document.getElementById('loading-state').hidden = true;
  document.getElementById('verdict-card').hidden = false;
  document.getElementById('timeline-section').hidden = false;

  // Masthead
  const ts = new Date().toLocaleString('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
  document.getElementById('case-kicker').textContent = `Case file · ${ts} UTC · ${verdict.correlation_id}`;
  document.getElementById('case-subject').innerHTML =
    `r/${escapeHtml(target?.subreddit ?? 'unknown')} <em>— ${verdict.tier.toLowerCase()} investigation</em>`;

  // Card chrome
  document.querySelector('.verdict').dataset.tier = verdict.calibrated_confidence < 0.60 ? 'LOW' : verdict.risk_tier;
  document.getElementById('v-target').innerHTML = targetLine(verdict, target);
  document.getElementById('v-title').innerHTML = titleFor(verdict);

  const pill = document.getElementById('risk-pill');
  if (verdict.calibrated_confidence < 0.60) {
    pill.className = 'risk-pill unsure';
    pill.textContent = 'Low conf.';
  } else {
    pill.className = `risk-pill ${verdict.risk_tier.toLowerCase()}`;
    pill.textContent = RISK_PILL_LABEL[verdict.risk_tier];
  }

  // Confidence row
  const pct = Math.round(verdict.calibrated_confidence * 100);
  document.getElementById('conf-pct').textContent = pct;
  requestAnimationFrame(() => { document.getElementById('conf-fill').style.width = `${pct}%`; });
  const tier = verdict.calibrated_confidence >= 0.80 ? 'HIGH'
    : verdict.calibrated_confidence >= 0.60 ? 'MEDIUM' : 'LOW';
  document.getElementById('conf-tier').textContent = TIER_INDICATOR[tier];

  // Honest uncertainty marginalia (LOW only)
  if (verdict.calibrated_confidence < 0.60) {
    const m = document.getElementById('marginalia');
    m.hidden = false;
    m.textContent = "I found the following but I'm not confident enough to recommend an action. Your judgment matters here.";
  }

  // ── New panels (Features 1, 2, 4, 5, 6, 7, 8) ──
  renderPriorityPill(verdict.priority);
  renderEscalationBanner(verdict.escalation);
  renderAuthorSignal(verdict.author_signal);
  renderConfidenceFactors(verdict.confidence_factors);
  renderKeyFactors(verdict.key_factors);
  renderRuleMatches(verdict.rule_matches);
  renderAlignmentLine(verdict.alignment);

  // Evidence + actions
  renderEvidence(verdict.top_evidence);
  renderActions(verdict);

  // Footer
  document.getElementById('v-footer-meta').innerHTML =
    `Strategy · <strong style="color: var(--ink);">${verdict.tier}</strong> · ${(verdict.latency_ms / 1000).toFixed(1)}s · $${verdict.cost_usd.toFixed(3)}`;

  document.getElementById('expand-toggle').addEventListener('click', () => {
    const section = document.getElementById('timeline-section');
    section.hidden = !section.hidden;
    document.getElementById('expand-toggle').textContent = section.hidden ? 'View reasoning ▾' : 'Hide reasoning ▴';
  });

  // Timeline
  renderTimeline(verdict);
  bindEvidenceLinking();
}

load();
wireResponseModal();
