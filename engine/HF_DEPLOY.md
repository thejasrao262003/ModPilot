# Deploying the Engine to HuggingFace Spaces

This is the deploy path for the ModPilot Investigation Engine. The HF Space
is a Docker container that runs FastAPI on port 7860, talks to Supabase
(Postgres) and Upstash (Redis), and is reached by the Devvit app over a
single HMAC-signed HTTPS endpoint.

## Space URL

`https://thejasrao-modpilot.hf.space`

(HF lowercases and hyphenates: `ThejasRao/ModPilot` → `thejasrao-modpilot.hf.space`.)

## One-time setup

### 1. Set repository secrets on the Space

HF Space → **Settings** → **Variables and secrets** → **New secret**. Add:

| Key | Value source |
|---|---|
| `GEMINI_API_KEY` | from `engine/.env` |
| `DATABASE_URL` | the Supabase **session pooler** URL with `+asyncpg` driver and URL-encoded password (see `engine/.env`) |
| `REDIS_URL` | the Upstash `rediss://` URL (TLS) |
| `ENGINE_SHARED_SECRET` | from `engine/.env` — must match `devvit-app/src/services/engineConfig.local.ts` |
| `ENV` | `production` |
| `LOG_LEVEL` | `INFO` |
| `MODEL_REASONER` | `gemini-2.5-pro` |
| `MODEL_SUMMARIZER` | `gemini-2.5-flash` |

Secrets become env vars at container start. Do **not** commit `.env` to the
HF Space repo — `.dockerignore` already excludes it.

### 2. Clone the Space repo locally

```bash
# Generate a write token at https://huggingface.co/settings/tokens
git clone https://huggingface.co/spaces/ThejasRao/ModPilot ~/hf-modpilot
```

### 3. Copy engine files into the Space repo

From this project root:

```bash
ENGINE=$(pwd)/engine
HF=~/hf-modpilot
rsync -av --delete \
  --exclude='.env' --exclude='.venv' --exclude='__pycache__' \
  --exclude='.pytest_cache' --exclude='.mypy_cache' --exclude='.ruff_cache' \
  --exclude='.git' \
  "$ENGINE"/ "$HF"/
```

### 4. Push

```bash
cd ~/hf-modpilot
git add -A
git commit -m "Deploy ModPilot engine"
git push   # use HF token as password
```

HF will build the image (~3-5 min) and start the container. Watch the build
logs in the Space's **Logs** tab.

## Verify the deploy

Once the Space shows "Running":

```bash
# Health (no auth required)
curl -s https://thejasrao-modpilot.hf.space/health | jq

# Investigate (HMAC-signed)
python scripts/probe_investigate.py  # if you have it, or use devvit-app
```

## Wire Devvit → HF Space

1. Edit `devvit-app/devvit.json` → `permissions.http.domains`:
   ```json
   "domains": ["thejasrao-modpilot.hf.space"]
   ```
2. Edit `devvit-app/src/services/engineConfig.local.ts`:
   ```ts
   export const ENGINE_URL = "https://thejasrao-modpilot.hf.space";
   export const ENGINE_SHARED_SECRET = "<same as HF secret>";
   ```
3. `cd devvit-app && npm run dev` (playtest). On first run Devvit auto-submits
   the domain via the 0.11.17 flow. Check **Developer Settings** tab in the
   app for approval status — usually fast.

## Operational notes

- **Cold start**: HF Spaces free tier sleeps after ~48h idle. First request
  pays ~30-60s. For a demo, hit `/health` a minute beforehand to wake it.
- **Migrations**: the container runs `alembic upgrade head` on every boot.
  Schema changes land just by pushing new revisions.
- **Logs**: Space → **Logs** tab. Structured JSON; `correlation_id` is the
  primary join key against Devvit-side logs.
- **Rebuild**: any push to the Space repo triggers a rebuild. Edits to env
  vars (Secrets UI) restart the container without rebuild.
- **Local dev unchanged**: `uv run uvicorn api.main:app --reload` still
  works locally against the same Supabase + Upstash. Just keep `ENV=development`
  in `engine/.env` so HMAC enforcement stays off for local probes.
