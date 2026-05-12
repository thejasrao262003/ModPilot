# 08 — API

> **Purpose:** The Investigation Engine's HTTP contract. Endpoints, schemas, auth, errors, idempotency. Load when working on the API layer or the Devvit HTTP client.
>
> **Status:** Static after MVP. Versioned changes thereafter.

---

## 1. Overview

The Investigation Engine exposes a small, opinionated HTTP API consumed by the Devvit app.

- **Base URL:** `https://modpilot-engine.fly.dev`
- **Versioning:** path-prefixed, `/v1/...`. Breaking changes ship as `/v2`.
- **Content type:** `application/json` everywhere. UTF-8.
- **Transport:** HTTPS only; HTTP rejected at the load balancer.
- **Auth:** HMAC request signing (Section 5). No bearer tokens, no OAuth.
- **Idempotency:** required on all non-idempotent endpoints via `Idempotency-Key` header.
- **Trace:** every request carries `X-ModPilot-Correlation-Id`. Echoed back in responses and logged everywhere.

The API is consumed by one client: the Devvit app. We do not expose it publicly. CORS is denied for browser origins.

---

## 2. Endpoint Index

| Method | Path | Purpose | Idempotent |
|---|---|---|---|
| POST | `/v1/investigate` | Run an investigation, return a verdict | No |
| POST | `/v1/feedback` | Record a mod action against a verdict | Yes (with key) |
| POST | `/v1/summarize-thread` | Summarize a Reddit thread on demand | Yes (cached) |
| GET  | `/v1/memory/user/{user_id}` | Read User Memory for a user in a subreddit | Yes |
| POST | `/v1/install` | Bootstrap subreddit on AppInstall | Yes |
| POST | `/v1/upgrade` | Run migrations on AppUpgrade | Yes |
| POST | `/v1/uninstall` | Mark subreddit for deletion on AppRemove | Yes |
| POST | `/v1/analytics/rollup` | Forward batched edge metrics | Yes |
| GET  | `/v1/health` | Liveness | Yes |
| GET  | `/v1/ready` | Readiness (DB + Redis + LLM provider) | Yes |
| GET  | `/v1/version` | Build version + prompt versions | Yes |

---

## 3. Common Request Headers

Every request to the Engine includes:

```
Content-Type: application/json
X-ModPilot-Subreddit: <subreddit_id>
X-ModPilot-Timestamp: <unix epoch seconds>
X-ModPilot-Signature: <hex hmac>
X-ModPilot-Correlation-Id: <uuid>
Idempotency-Key: <uuid>                      # required on non-idempotent endpoints
User-Agent: ModPilot-Devvit/<version>
```

`X-ModPilot-Subreddit` is the scope for the entire request. The Engine cross-checks it against the request body's `subreddit_id` and rejects mismatches with `400 SUBREDDIT_MISMATCH`.

---

## 4. Common Response Envelope

Every response wraps its payload:

```json
{
  "ok": true,
  "data": { ... },
  "meta": {
    "correlation_id": "uuid",
    "latency_ms": 3142,
    "version": "engine-1.2.3",
    "request_id": "uuid"
  }
}
```

On error:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "human-readable summary",
    "details": { ... },
    "retryable": false
  },
  "meta": { ... }
}
```

Error codes catalog lives in Section 11.

---

## 5. Auth: HMAC Signing

The Engine and Devvit share a secret rotated quarterly. Every request is signed.

### 5.1 Signed Payload

```
<METHOD>\n<PATH>\n<TIMESTAMP>\n<SHA256(body)>
```

Hex-encoded HMAC-SHA256 of the above, placed in `X-ModPilot-Signature`.

### 5.2 Server Verification

1. Reject if `X-ModPilot-Timestamp` skew exceeds 5 minutes (replay window).
2. Reject if `Idempotency-Key` is missing on non-idempotent endpoints.
3. Recompute the signature; reject on mismatch.
4. Reject if `X-ModPilot-Subreddit` does not match the request body's subreddit fields.

All four failures map to `401 AUTH_FAILED` with no further detail (intentionally opaque).

### 5.3 Secret Rotation

Two secrets active simultaneously during a rotation window. The Engine accepts either; Devvit signs with the new one. Rotation flow documented in `13-Infra.md`.

---

## 6. POST `/v1/investigate`

The primary endpoint. Run an investigation and return a Verdict.

### 6.1 Request

```json
{
  "subreddit_id": "sub_abc",
  "target_id": "comment_xyz",
  "target_type": "comment",
  "author_id": "user_def",
  "report_reason": "harassment",
  "report_count": 4,
  "reports_per_minute": 0.8,
  "thread_velocity": 12,
  "post_id": "post_qrs",
  "comment_depth": 3,
  "post_age_minutes": 47,
  "content_excerpt": "<short, may be omitted; Engine has its own Reddit creds for fetching>",
  "trigger_source": "report",
  "menu_invoked": false
}
```

Idempotency-Key: `<uuid>`. Same key within 60s returns the cached verdict.

### 6.2 Timeouts

| Caller | Client timeout |
|---|---|
| Devvit trigger path | 6,000 ms |
| Devvit menu action path | 10,000 ms |

The Engine's internal hard cap is per-tier (per `04-InvestigationEngine.md`).

### 6.3 Response (`200 OK`)

```json
{
  "ok": true,
  "data": {
    "verdict_id": "uuid",
    "subreddit_id": "sub_abc",
    "target_id": "comment_xyz",
    "recommendation": "REMOVE",
    "confidence": 0.84,
    "confidence_tier": "MEDIUM",
    "risk_tier": "HIGH",
    "rationale": "Author has 3 prior removals [ev-2]. Thread shows escalation from turn 8 [ev-5]. Matches Rule 2 [ev-1].",
    "cited_evidence_ids": ["ev-1", "ev-2", "ev-5"],
    "top_evidence": [
      { "id": "ev-1", "summary": "Strong match against Rule 2: Personal Attacks", "weight": 0.81 },
      { "id": "ev-2", "summary": "3 prior removals in last 30 days", "weight": 0.70 },
      { "id": "ev-5", "summary": "Thread escalation detected at turn 8", "weight": 0.65 }
    ],
    "timeline": [
      { "sequence": 1, "tool": "policy_match", "status": "success", "duration_ms": 142,
        "summary": "Matched Rule 2 (similarity 0.81)", "evidence_ids": ["ev-1"] },
      { "sequence": 2, "tool": "report_velocity", "status": "success", "duration_ms": 23,
        "summary": "4 reports in 6 min (z=6.2)", "evidence_ids": ["ev-4"] },
      { "sequence": 3, "tool": "user_history", "status": "success", "duration_ms": 87,
        "summary": "3 prior removals; risk tier: watched", "evidence_ids": ["ev-2", "ev-3"] },
      { "sequence": 4, "tool": "thread_context", "status": "success", "duration_ms": 1180,
        "summary": "Escalation from turn 8; off-topic flag: false", "evidence_ids": ["ev-5"] }
    ],
    "flags": [],
    "fallback": false,
    "is_partial": false,
    "cold_start": false,
    "meta": {
      "tier": "STANDARD",
      "tools_used": ["policy_match", "report_velocity", "user_history", "thread_context"],
      "latency_ms": 1432,
      "cost_usd": 0.0184,
      "prompt_version": "reasoner-v1.0"
    }
  },
  "meta": { ... }
}
```

### 6.4 Special-Case Responses

- **`200 OK` with `recommendation: "NO_ACTION"` and `confidence_tier: "LOW"`:** the honest-uncertainty case. UI displays evidence without a suggested action.
- **`200 OK` with `is_partial: true`:** budget exhausted before convergence; verdict still ships, confidence demoted.
- **`200 OK` with `fallback: true`:** rule-based fallback (LLM unavailable); UI surfaces the degraded-mode badge.
- **`200 OK` with `validation_passed: false` in flags:** post-generation validation failed twice; verdict ships at LOW confidence with the "ModPilot is unsure" UX.

The endpoint **always returns a verdict** when it returns `200`. The shape of the verdict carries honesty signals; the status code does not.

### 6.5 Error Responses

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed body, missing required fields |
| 400 | `SUBREDDIT_MISMATCH` | Header subreddit ≠ body subreddit |
| 401 | `AUTH_FAILED` | HMAC, timestamp, or idempotency-key failure |
| 409 | `IDEMPOTENT_REPLAY_DIFFERS` | Same key, different body |
| 429 | `RATE_LIMITED` | Per-subreddit cost cap reached |
| 503 | `KILL_SWITCH_ACTIVE` | Subreddit `enabled=false` setting |
| 503 | `ENGINE_DEGRADED` | Critical dependency unavailable (DB down) |
| 504 | `INVESTIGATION_TIMEOUT` | Tier's hard cap exceeded |

`504` responses still include any partial work in the error `details` so Devvit can surface "ModPilot timed out — partial evidence below" UX.

---

## 7. POST `/v1/feedback`

Records a mod action against a previously-issued verdict. Drives the adaptation loop.

### 7.1 Request

```json
{
  "subreddit_id": "sub_abc",
  "investigation_id": "uuid",
  "mod_id": "user_ghi",
  "mod_action": "REMOVE",
  "recommendation": "REMOVE",
  "alignment": "ACCEPTED",
  "occurred_at": "2026-05-12T14:31:22Z"
}
```

`alignment` is one of `ACCEPTED | REJECTED | OVERRIDDEN | CONFIRMED_NO_ACTION`, computed Devvit-side and passed in.

Idempotency-Key required. Replaying the same key is a no-op.

### 7.2 Response (`200 OK`)

```json
{
  "ok": true,
  "data": { "recorded": true, "feedback_id": "uuid" },
  "meta": { ... }
}
```

### 7.3 Semantics

- **Durable on receipt.** The feedback row is written to Postgres synchronously before the response returns. No batching here.
- **Memory updates are eventually consistent.** Counters propagate to Redis immediately; Postgres flush within 5 min.
- **No verdict reversal.** Feedback doesn't retroactively change the verdict row — the audit trail is preserved.

### 7.4 Errors

| Status | Code | When |
|---|---|---|
| 404 | `INVESTIGATION_NOT_FOUND` | `investigation_id` doesn't exist or belongs to another sub |
| 409 | `FEEDBACK_ALREADY_RECORDED` | Different feedback already exists for this investigation (without idempotency key matching) |
| 400 | `INVALID_ALIGNMENT` | `alignment` doesn't match `mod_action` vs `recommendation` |

---

## 8. POST `/v1/summarize-thread`

On-demand thread summarization, invoked by the "Summarize Thread" menu action. Bypasses the full investigation pipeline.

### 8.1 Request

```json
{
  "subreddit_id": "sub_abc",
  "post_id": "post_qrs",
  "comment_count_hint": 47
}
```

Cached aggressively. The Engine resolves the bucket (`comment_count // 10 * 10`) and returns cache when available.

### 8.2 Response (`200 OK`)

```json
{
  "ok": true,
  "data": {
    "arc": "Discussion of policy change drifts into personal attacks at turn 8.",
    "escalation_points": [
      { "turn": 8, "temperature": 0.72 },
      { "turn": 14, "temperature": 0.88 }
    ],
    "instigator_candidates": ["u_a"],
    "off_topic": false,
    "notable_quotes": [
      "User u_a redirected the discussion toward personal characterization at turn 8."
    ],
    "from_cache": true,
    "bucket": 40
  },
  "meta": { ... }
}
```

Notable quotes are **paraphrased**, not verbatim. The Engine never reproduces copyrighted Reddit content directly.

### 8.3 Errors

| Status | Code |
|---|---|
| 404 | `POST_NOT_FOUND` |
| 503 | `SUMMARIZER_DEGRADED` (Haiku down; falls back to raw transcript Devvit-side) |

---

## 9. GET `/v1/memory/user/{user_id}`

Reads User Memory for the "Show Moderation Memory" menu action.

### 9.1 Request

```
GET /v1/memory/user/user_def
X-ModPilot-Subreddit: sub_abc
... (standard signed headers)
```

### 9.2 Response (`200 OK`)

```json
{
  "ok": true,
  "data": {
    "user_id": "user_def",
    "subreddit_id": "sub_abc",
    "first_seen": "2025-11-03T10:14:00Z",
    "last_seen": "2026-05-12T13:08:00Z",
    "risk_tier": "watched",
    "prior_violations": { "harassment": 2, "spam": 1 },
    "borderline_incidents": 2,
    "recent_actions": [
      { "action": "REMOVE", "category": "harassment", "ts": "2026-05-08T..." },
      { "action": "APPROVE", "category": "borderline", "ts": "2026-04-29T..." }
    ],
    "trust_tier_label": "watched"
  },
  "meta": { ... }
}
```

Note: the raw `trust_score` float is **never** returned. Only the tier label. (Per `05-Memory.md` invariant.)

### 9.3 Errors

| Status | Code |
|---|---|
| 404 | `USER_MEMORY_NOT_FOUND` (returns empty memory, 200) |
| 403 | `CROSS_SUB_ACCESS_DENIED` (sub mismatch) |

---

## 10. Lifecycle Endpoints

### 10.1 POST `/v1/install`

Called by Devvit's `onAppInstall` trigger.

Request:
```json
{ "subreddit_id": "sub_abc", "subreddit_name": "r/example", "installed_at": "..." }
```

Response: `200 OK` with `{ "bootstrapped": true }`. Creates `subreddit_config`, empty `subreddit_memory`, default personality (Balanced), cold-start flag set.

### 10.2 POST `/v1/upgrade`

Called by `onAppUpgrade`. Body carries `from_version` and `to_version`. The Engine runs any data migrations keyed off these versions.

Response: `200 OK` with `{ "migrated": true, "actions": [...] }`.

### 10.3 POST `/v1/uninstall`

Called by `onAppRemove`. The Engine sets `subreddit_config.pending_deletion = now() + 30d` (see `07-DataLayer.md` retention).

Response: `200 OK` with `{ "marked_for_deletion": true, "delete_at": "..." }`.

### 10.4 POST `/v1/analytics/rollup`

Devvit's hourly job forwards batched edge metrics here.

Request:
```json
{
  "subreddit_id": "sub_abc",
  "window_start": "...",
  "window_end": "...",
  "events": [
    { "type": "verdict_rendered", "count": 47 },
    { "type": "timeline_expanded", "count": 12 }
  ]
}
```

Response: `200 OK` with `{ "ingested": 59 }`.

---

## 11. Error Codes Catalog

| Code | HTTP | Retryable | Notes |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | No | Malformed request body |
| `SUBREDDIT_MISMATCH` | 400 | No | Header ≠ body subreddit |
| `INVALID_ALIGNMENT` | 400 | No | Feedback inconsistency |
| `AUTH_FAILED` | 401 | No | HMAC / timestamp / replay |
| `CROSS_SUB_ACCESS_DENIED` | 403 | No | Sub isolation violation |
| `INVESTIGATION_NOT_FOUND` | 404 | No | |
| `POST_NOT_FOUND` | 404 | No | |
| `USER_MEMORY_NOT_FOUND` | 404 | No | Note: also 200 with empty body in normal path |
| `IDEMPOTENT_REPLAY_DIFFERS` | 409 | No | Same key, different body |
| `FEEDBACK_ALREADY_RECORDED` | 409 | No | |
| `RATE_LIMITED` | 429 | Yes (after delay) | Includes `Retry-After` header |
| `KILL_SWITCH_ACTIVE` | 503 | No until re-enabled | Subreddit-level pause |
| `ENGINE_DEGRADED` | 503 | Yes | DB / Redis / LLM provider down |
| `SUMMARIZER_DEGRADED` | 503 | Yes | Haiku unavailable |
| `INVESTIGATION_TIMEOUT` | 504 | Yes | Tier hard cap exceeded |
| `INTERNAL_ERROR` | 500 | Yes | Unexpected — logged with full trace |

Client guidance per code lives in `devvit-app/src/services/engineClient.ts` as a switch in the error handler.

---

## 12. Rate Limiting

Per-subreddit cost cap drives rate-limiting:

| Window | Cap | Behavior |
|---|---|---|
| Hourly | $1.00 | Subsequent investigations return `429 RATE_LIMITED` with `Retry-After` |
| Daily | $5.00 | Same, but window resets at UTC midnight |

`Retry-After` is set to the seconds until the next window opens. Devvit defers retries accordingly.

`/v1/feedback`, `/v1/memory/*`, and lifecycle endpoints are **not** rate-limited. They cost effectively nothing.

`/v1/health` and `/v1/ready` are exempt.

---

## 13. Idempotency

Every non-idempotent endpoint requires `Idempotency-Key: <uuid>`.

- The Engine stores the request hash and response under `idem:<key>` in Redis for 60 seconds.
- Same key + same body → cached response.
- Same key + different body → `409 IDEMPOTENT_REPLAY_DIFFERS`.
- Missing key → `401 AUTH_FAILED` (treated as auth failure since signing requires it).

This protects against double-fires from Devvit retries and trigger replays.

---

## 14. Health & Readiness

### 14.1 GET `/v1/health`

Trivial liveness. Returns `200 OK` if the process is up.

```json
{ "ok": true, "data": { "status": "alive" } }
```

### 14.2 GET `/v1/ready`

Checks all critical dependencies. Returns `200` if ready, `503` if not.

```json
{
  "ok": true,
  "data": {
    "postgres": "ok",
    "redis": "ok",
    "llm_provider": "ok",
    "reasoner_prompt_version": "v1.0",
    "summarizer_prompt_version": "v1.0"
  }
}
```

A 503 response means Devvit should open its circuit breaker and degrade gracefully (per `03-Devvit.md` Section 9.5).

### 14.3 GET `/v1/version`

```json
{
  "ok": true,
  "data": {
    "engine": "1.2.3",
    "git_sha": "abc1234",
    "reasoner_prompt": "v1.0",
    "summarizer_prompt": "v1.0",
    "model_reasoner": "gemini-2.5-pro",
    "model_summarizer": "gemini-2.5-flash"
  }
}
```

---

## 15. Observability

Every request:
- Emits `request.started` and `request.completed` structured logs with correlation ID, route, status, latency.
- Increments `api.requests.total{route, status}` counter.
- Records `api.latency_ms{route}` histogram.

Errors additionally emit `request.failed` with the error code (no stack traces in logs visible to mods; full traces in private engine logs).

Investigations also emit the per-investigation events documented in `04-InvestigationEngine.md` Section 14, threaded by correlation ID.

---

## 16. API Invariants

1. Every endpoint validates `X-ModPilot-Subreddit` against the body's subreddit fields. Cross-sub leakage is structurally impossible.
2. Every non-idempotent endpoint requires `Idempotency-Key`. Replays are deterministic.
3. Every response includes `correlation_id` in `meta`.
4. Every error response includes a `retryable` boolean. Clients respect it.
5. No endpoint executes Reddit moderation actions. The Engine only recommends.
6. No endpoint exposes raw `trust_score` floats or LLM internals.
7. The `/v1/investigate` endpoint always returns a verdict on 200, even when degraded — the verdict's flags carry the honesty signals.
8. No endpoint returns data scoped to a different subreddit than the request header.

Violating any of these is a bug.

---

## 17. Related Documents

- [`03-Devvit.md`](03-Devvit.md) — The Devvit-side HTTP client (`engineClient.ts`), timeouts, retry policy, circuit breaker.
- [`04-InvestigationEngine.md`](04-InvestigationEngine.md) — What the `/investigate` endpoint actually does internally.
- [`05-Memory.md`](05-Memory.md) — Backing for `/memory/user/*`.
- [`06-AILayer.md`](06-AILayer.md) — Models / prompts surfaced in `/version`.
- [`07-DataLayer.md`](07-DataLayer.md) — Tables backing every endpoint.
- [`10-ReliabilityAndSafety.md`](10-ReliabilityAndSafety.md) — Kill switch, degraded mode, PII rules.
- [`13-Infra.md`](13-Infra.md) — Secret rotation, deployment, allowlisting.
- [`14-Engineering.md`](14-Engineering.md) — FastAPI patterns, testing, async conventions.