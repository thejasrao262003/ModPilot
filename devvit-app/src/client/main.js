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

function onAction(label, verdict) {
  // S-1.6 will POST to /api/feedback. For now: visible feedback only.
  alert(`${label} clicked. (S-1.6 will record this as feedback.)\n\nVerdict: ${verdict.recommendation} at ${Math.round(verdict.calibrated_confidence * 100)}% conf.`);
}

async function load() {
  const root = document.getElementById('root');
  try {
    const correlationId = new URL(location.href).searchParams.get('c') ?? 'canned';
    const res = await fetch(`/api/verdict/canned?c=${encodeURIComponent(correlationId)}`, {
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
