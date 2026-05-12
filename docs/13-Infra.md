# 13 — Infrastructure

> **Purpose:** Deployment, secrets, observability, and local dev. Load when deploying, configuring environments, or setting up a contributor.
>
> **Status:** Static. Infrastructure choices change via ADR.

---

## 1. Deployment Topology

```
┌─────────────────────────────────────────────────────────────┐
│                  REDDIT PLATFORM                             │
│              (Devvit app runs here, edge)                    │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS (HMAC-signed)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                       FLY.IO                                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Engine app (FastAPI)                               │    │
│  │  - 2 machines, 1GB RAM each, autoscale 1-4          │    │
│  │  - Region: iad (primary)                            │    │
│  └────────────────────┬────────────────────────────────┘    │
│  ┌────────────────────▼────────────────────────────────┐    │
│  │  Worker app (jobs: rollups, retries, deletions)     │    │
│  │  - 1 machine, 512MB RAM                             │    │
│  └─────────────────────────────────────────────────────┘    │
└───────────┬─────────────────────────────────┬───────────────┘
            │                                 │
            ▼                                 ▼
   ┌──────────────────┐              ┌──────────────────┐
   │  Postgres        │              │  Redis           │
   │  (Supabase free) │              │  (Upstash free)  │
   └──────────────────┘              └──────────────────┘
            ▲
            │
            ▼
   ┌──────────────────┐
   │  LLM Providers   │
   │  Gemini API      │
   └──────────────────┘
```

### 1.1 Service Sizing (MVP)

| Service | Resources | Cost |
|---|---|---|
| Engine (Fly.io) | 2× shared-cpu-1x, 1GB, autoscale 1-4 | ~$5–15/mo |
| Worker (Fly.io) | 1× shared-cpu-1x, 512MB | ~$2/mo |
| Postgres (Supabase) | Free tier (500MB, 2 cores) | $0 |
| Redis (Upstash) | Free tier (10K cmds/day) | $0 |
| Gemini API | usage-based | $5–30 expected for hackathon |
| **Total runtime** | | **<$50 for hackathon period** |

Free tiers handle hackathon scale comfortably. Production scale would require paid tiers (~$50–100/mo). Migration paths documented inline below.

### 1.2 Why Fly.io

- One-command deploy (`fly deploy`).
- Generous free allowance.
- Simple multi-region path (move from 1 region to N via a single config change post-MVP).
- WebSocket / streaming support for future features.

Alternatives considered: Cloud Run (more configuration overhead), Railway (less mature), Render (slower cold starts).

### 1.3 Why Supabase / Neon for Postgres

Either works; we go with Supabase. Reasons:
- Free tier includes `pgvector` extension (we need it for `policy_match`).
- Built-in backups + point-in-time recovery.
- Familiar Postgres; no proprietary lock-in.

### 1.4 Why Upstash for Redis

- Serverless pricing model — pay for commands, not capacity.
- HTTPS API (avoids long-lived TCP connections from Fly.io).
- Free tier is generous for our cache + counter usage.

---

## 2. Environments

Three environments. All share the same code; differ in configuration.

| Env | Purpose | Engine URL | DB | Redis |
|---|---|---|---|---|
| `dev` | Local development | `http://localhost:8000` | Local Postgres | Local Redis |
| `staging` | Pre-prod testing | `modpilot-engine-staging.fly.dev` | Supabase staging project | Upstash staging DB |
| `prod` | Live | `modpilot-engine.fly.dev` | Supabase prod project | Upstash prod DB |

**Data isolation:** each environment has its own DB and Redis instance. **No data flows between environments.** Even staging never sees prod data.

**Feature flags:** there is no runtime feature-flag service in MVP. Gating happens at deploy time via environment variables. Post-MVP, add LaunchDarkly-style if needed.

---

## 3. Secrets

Every secret has a single source of truth and a rotation policy.

### 3.1 Inventory

| Secret | Used by | Stored in | Rotation |
|---|---|---|---|
| `GEMINI_API_KEY` | Engine | Fly.io secrets | Quarterly |
| `MODPILOT_HMAC_SECRET` | Engine + Devvit | Fly.io secrets + Devvit settings | Quarterly |
| `POSTGRES_URL` | Engine, Worker | Fly.io secrets | On compromise |
| `REDIS_URL` | Engine, Worker | Fly.io secrets | On compromise |
| `GRAFANA_API_KEY` | Engine (metrics push) | Fly.io secrets | Annually |

### 3.2 Storage Rules

- **Production secrets:** Fly.io secrets only (`fly secrets set KEY=value`). Never committed.
- **Devvit-side HMAC secret:** stored in Devvit's encrypted settings. Accessed only via `context.settings`. Never exposed to UI code.
- **Local dev:** `.env` files; `.env` is gitignored. `.env.example` is committed with placeholders.
- **No secrets in CI logs:** secrets are masked in GitHub Actions output.

### 3.3 Rotation Procedure (HMAC Secret)

The HMAC secret is the most operationally important. Rotation flow:

1. Generate new secret (`openssl rand -hex 32`).
2. Set as `MODPILOT_HMAC_SECRET_NEXT` on both Engine and Devvit.
3. Engine accepts requests signed by either old or new secret (overlap window).
4. Devvit starts signing with `_NEXT`.
5. After 24h, swap: `_NEXT` becomes `MODPILOT_HMAC_SECRET`; old is removed.
6. Audit log entry recorded.

No downtime. The overlap window is the safety margin.

### 3.4 Compromise Response

If a secret is suspected compromised:
1. Rotate immediately, no overlap window (accept brief request failures).
2. Audit logs for unusual API patterns over the prior 30 days.
3. Force re-issue of any derived credentials.
4. Post-mortem ADR.

---

## 4. Deployment

### 4.1 Engine

```bash
cd engine
fly deploy --remote-only
```

The `fly.toml` config:
- Builds from `engine/Dockerfile`.
- Sets autoscale min=1, max=4.
- Routes `/v1/health` for liveness, `/v1/ready` for readiness.
- Mounts secrets at startup.

Deploys are zero-downtime via Fly's rolling release. Old machines stop accepting new requests, finish in-flight, then exit.

### 4.2 Worker

```bash
cd engine
fly deploy --config fly.worker.toml --remote-only
```

Separate Fly app (`modpilot-worker`) with `WORKER_MODE=true` env var so the same image runs in worker mode (no API server; runs scheduled jobs).

### 4.3 Devvit App

```bash
cd devvit-app
devvit upload
```

Devvit publishes to Reddit's platform. The first upload requires `devvit login`. Updates flow through Reddit's app review process.

### 4.4 Rollback

Engine:
```bash
fly releases list
fly releases rollback <version>
```

Devvit: upload the previous version explicitly. There's no rollback button; we keep the last 3 release tags handy.

### 4.5 Migrations

Database migrations run on Engine startup if the `RUN_MIGRATIONS=true` env var is set. We set it only on a dedicated one-off machine before each release:

```bash
fly machine run --rm --env RUN_MIGRATIONS=true <image>
```

This runs `alembic upgrade head` and exits. Then we deploy the normal Engine. This separation prevents accidental migrations from running across multiple instances simultaneously.

---

## 5. Local Dev Setup

Goal: from a fresh checkout, full local stack running in under 10 minutes.

### 5.1 Prereqs

- Python 3.11+ (we recommend `uv` for env management)
- Node.js 20+ for Devvit
- Docker (for local Postgres + Redis)
- `make`

### 5.2 Bootstrap

```bash
# 1. Clone and enter
git clone <repo> modpilot && cd modpilot

# 2. Start local services
make services-up      # docker-compose: Postgres + Redis

# 3. Engine
cd engine
uv sync
cp .env.example .env  # fill GEMINI_API_KEY at minimum
uv run alembic upgrade head
uv run uvicorn api.main:app --reload

# 4. Devvit (separate terminal)
cd devvit-app
npm install
devvit login
devvit upload         # publishes to your test subreddit

# 5. Run eval to confirm everything works
cd eval
uv run python -m eval.harness --tags p0 --prompt-version reasoner-v1.0
```

### 5.3 Required Env Vars

`engine/.env.example`:

```bash
# LLM
GEMINI_API_KEY=...

# Stores
POSTGRES_URL=postgresql://modpilot:modpilot@localhost:5432/modpilot
REDIS_URL=redis://localhost:6379

# Auth
MODPILOT_HMAC_SECRET=local_dev_secret_change_me

# Models (defaults shown)
MODEL_REASONER=gemini-2.5-pro
MODEL_SUMMARIZER=gemini-2.5-flash

# Behavior
COLD_START_THRESHOLD=50
LOG_LEVEL=info
ENV=dev
```

### 5.4 Common Commands

```bash
make services-up      # docker-compose up
make services-down    # docker-compose down
make migrate          # run pending migrations
make migrate-create   # create new migration
make test             # unit tests
make eval-gate        # run regression eval
make engine-dev       # uvicorn with reload
make devvit-upload    # upload to test subreddit
make lint             # ruff + tsc
make typecheck        # mypy + tsc --noEmit
```

### 5.5 Troubleshooting

- **Devvit upload fails:** confirm `devvit login` and that the test subreddit is one you moderate.
- **Postgres connection refused:** confirm `make services-up` ran cleanly; `docker ps` shows the container.
- **Migrations fail:** drop the local DB and recreate (`make services-reset`).
- **LLM calls fail with 401:** check `GEMINI_API_KEY` is set in `.env` and `uvicorn` was restarted after change.
- **HMAC signature mismatch in dev:** confirm Devvit settings have the same `MODPILOT_HMAC_SECRET` as the Engine's `.env`.

---

## 6. Observability Stack

### 6.1 Logs

- **Format:** structured JSON, one line per event.
- **Destination:** stdout (Fly.io captures).
- **Aggregation:** Grafana Cloud Loki (free tier).
- **Retention:** 14 days on free tier.

Every log line includes: `timestamp`, `level`, `correlation_id`, `subreddit_id` (when applicable), `event`, plus event-specific fields.

```python
logger.info("investigation.completed",
    correlation_id=cid,
    subreddit_id=sub_id,
    tier="STANDARD",
    cost_usd=0.018,
    latency_ms=1432
)
```

### 6.2 Metrics

- **Format:** Prometheus exposition format on `/metrics` endpoint.
- **Scraping:** Grafana Cloud Prometheus (free tier).
- **Retention:** 14 days on free tier.

Metric catalog in `12-Analytics.md`. Implementation: `engine/observability/metrics.py`.

### 6.3 Tracing

**Not enabled for MVP.** Correlation IDs propagate through logs; that's sufficient for the hackathon. Add OpenTelemetry post-MVP if latency debugging requires it.

### 6.4 Alerts

Defined in `engine/observability/alerts.yaml`. Synced to Grafana via API on deploy. Alert channels:

- **Severity-1** (data leak, kill switch needed): paged immediately via Discord webhook.
- **Severity-2** (degraded service): notified in #alerts Slack channel.
- **Severity-3** (anomalies): daily digest email.

For hackathon: alerts route to a single Discord channel the team monitors.

### 6.5 Dashboards

Two Grafana dashboards, both reading from the same data:

- **Engine Health** — request rates, latencies, error rates, cache hit rates.
- **Business Metrics** — investigations/hour, cost trends, validation pass rate, alignment distribution.

Both published from JSON in `engine/observability/dashboards/`.

---

## 7. CI/CD

GitHub Actions workflows in `.github/workflows/`.

### 7.1 Engine CI (`engine-ci.yml`)

Triggered on PRs touching `engine/**`:

1. Lint (`ruff`).
2. Type check (`mypy`).
3. Unit tests (`pytest`).
4. Eval gate (`make eval-gate`) — when prompts or orchestrator change.

All gates must pass for merge.

### 7.2 Devvit CI (`devvit-ci.yml`)

Triggered on PRs touching `devvit-app/**`:

1. Lint (`eslint`).
2. Type check (`tsc --noEmit`).
3. Unit tests (`jest`).
4. Build (`npm run build`).

### 7.3 Deploy Workflow (`deploy.yml`)

Triggered on merge to `main`:

1. Engine CI passes.
2. Run migrations on staging (`alembic upgrade head`).
3. Deploy to staging.
4. Smoke test against staging.
5. Manual approval gate for prod.
6. Run migrations on prod.
7. Deploy to prod.
8. Smoke test against prod.

For hackathon, manual approval gate may be removed — every merge to main goes straight to prod. Re-enable post-hackathon.

---

## 8. Devvit Configuration

### 8.1 `devvit.yaml` (HTTP Allowlist)

```yaml
name: modpilot
version: 0.1.0

permissions:
  reddit:
    asUser: false
    scope:
      - read
      - modposts
      - modcontributors
      - modlog
      - modwiki

http:
  domains:
    - modpilot-engine.fly.dev
```

We allowlist exactly one domain — the prod Engine. **Never use wildcards. Never allowlist a domain we don't own.** This is one of the things judges check.

For staging testing: a separate Devvit app (`modpilot-staging`) with `modpilot-engine-staging.fly.dev` allowlisted. Production Devvit app is locked to prod only.

### 8.2 Test Subreddit

Each developer has their own test subreddit (typically `r/<username>_modpilot_test`). Devvit's local upload sandbox uses these. Never test against subreddits with real users.

---

## 9. Cost Controls

### 9.1 Per-Subreddit Cost Caps

Per `06-AILayer.md` Section 9:
- Hourly: $1.00
- Daily: $5.00

Configurable via env var (`COST_CAP_HOURLY_USD`, `COST_CAP_DAILY_USD`). Defaults are conservative.

### 9.2 Global Cost Ceiling

A secondary ceiling at the deployment level:

```bash
GLOBAL_DAILY_COST_CAP_USD=50.0
```

When total Gemini spend across all subreddits exceeds this, the Engine returns `503 ENGINE_DEGRADED` for `/investigate` until UTC midnight. Prevents a runaway loop from blowing the hackathon budget overnight.

### 9.3 Budget Alerts

- 50% of daily cap → log + Discord notification.
- 80% of daily cap → log + Discord notification + Slack DM.
- 100% → kill switch trips automatically.

These are monitored by the same observability stack as everything else.

---

## 10. Backup & Recovery

### 10.1 Postgres

- **Backups:** Supabase performs daily snapshots automatically.
- **PITR:** Point-in-time recovery within 7 days on free tier, longer on paid.
- **Manual export:** `pg_dump` on demand.

### 10.2 Redis

- **No backup.** Redis is ephemeral by design. Repopulates from Postgres + live traffic on cold-start.
- **Acceptable loss:** Cache + counters lose at most a few minutes of state.

### 10.3 Devvit KV

- **Managed by Reddit.** We don't back it up directly.
- **Reconstructible** from the Engine — re-investigate or re-render verdicts from `verdicts` table.

### 10.4 RPO / RTO Targets

- **RPO (data loss tolerance):** 24h for analytics, 0 for feedback (durable on receipt).
- **RTO (recovery time):** 1h for full Engine restore, <15min for failover to a redeployed instance.

Recovery procedure documented in `10-ReliabilityAndSafety.md` Section 16 (Incident Runbook).

---

## 11. Network & Egress

### 11.1 Egress Allowlist

Engine egress is unrestricted — it needs to reach Gemini, Postgres, Redis, Grafana. Locked-down egress is post-MVP infrastructure.

### 11.2 Inbound

- Engine: only `0.0.0.0:8080` (Fly.io front door). Internal port 8000.
- Worker: no inbound. Outbound only.
- Postgres, Redis: managed by providers; we hold the connection strings.

### 11.3 TLS

- Engine: TLS terminated by Fly.io edge. Internal traffic plain HTTP within Fly's private network.
- Postgres: TLS to Supabase always.
- Redis: HTTPS to Upstash (their REST API).
- Gemini: HTTPS always.

---

## 12. Disaster Scenarios

### 12.1 Fly.io Region Down

- Single-region deploy in MVP. Region failure → Engine down → Devvit circuit breakers open → mod queue continues working natively.
- Recovery: redeploy to a different region. ~15 min.
- Post-MVP: multi-region deploy with automatic failover.

### 12.2 Supabase Project Lost

- Restore from daily snapshot (≤24h data loss).
- Recovery: rebuild project from `pg_dump`, update `POSTGRES_URL`. ~1h.

### 12.3 Gemini API Unreachable

- Engine falls back to rule-based verdicts (per `06-AILayer.md`).
- All verdicts ship with `fallback: true` and LOW confidence.
- Mods see degraded-mode banner.
- Recovery: no action needed. Engine resumes normal operation when API returns.

### 12.4 Devvit Platform Issues

- Reddit's Devvit platform is outside our control.
- If Devvit is down, ModPilot is down. No mitigation.
- Recovery: wait. Communicate via status updates on the App Directory listing.

---

## 13. Infra Invariants

1. No secrets are ever committed to the repo.
2. Production and staging share no databases, no Redis instances, no secrets.
3. The Engine's HTTP allowlist contains exactly one domain per environment.
4. Every deploy includes a migration step (or explicit no-op note).
5. Every secret has a documented rotation procedure.
6. Cost caps are enforced at three layers: per-investigation budgets, per-subreddit caps, global daily cap.
7. Free-tier resources are sufficient for hackathon scale; paid migration is documented but not required.
8. The `devvit.yaml` HTTP allowlist is never `*` and never includes a domain we don't own.

Violating any of these is an infrastructure bug.

---

## 14. Migration to Production Scale

Notes for post-hackathon scaling, kept here so they're available when needed.

| Bottleneck | When it hits | Action |
|---|---|---|
| Postgres free tier (500MB) | ~10K active subreddits | Upgrade to Supabase Pro ($25/mo, 8GB) |
| Redis free tier (10K cmds/day) | ~50 active subreddits | Upgrade Upstash to pay-as-you-go |
| Fly.io shared CPU latency | sustained >10 req/s | Switch to dedicated CPU; horizontal scale |
| Single region latency for global mods | >30% non-US traffic | Multi-region Fly.io deploy |
| Gemini rate limits | sustained >50 req/min | Request tier increase from Gemini |

Each migration is a few hours of work with zero downtime if planned. Not blocking for MVP.

---

## 15. Open Questions

- **When to add OpenTelemetry tracing?** Defer until correlation-ID logging proves insufficient.
- **When to move to multi-region?** Defer until non-US mod feedback indicates latency issues.
- **Self-host Postgres post-MVP?** Probably not — Supabase free→Pro path is cheap enough that ops overhead isn't justified at our scale.
- **Should Worker run on the same Fly app as Engine, with role-based startup?** Currently separate apps; revisit if deploy complexity warrants consolidation.

Tracked in root `CLAUDE.md`.

---

## 16. Related Documents

- [`02-Architecture.md`](02-Architecture.md) — Service topology.
- [`03-Devvit.md`](03-Devvit.md) — Devvit-side HTTP client, allowlisting.
- [`07-DataLayer.md`](07-DataLayer.md) — Postgres + Redis usage.
- [`08-API.md`](08-API.md) — Auth, HMAC signing, secret rotation.
- [`10-ReliabilityAndSafety.md`](10-ReliabilityAndSafety.md) — Incident runbook, alerts.
- [`12-Analytics.md`](12-Analytics.md) — Metrics and dashboard sources.
- [`14-Engineering.md`](14-Engineering.md) — CI conventions, testing.