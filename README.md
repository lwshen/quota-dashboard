> **English** | [中文](./README.zh-CN.md)

# Quota Dashboard

A web dashboard that shows AI providers' quota / usage. It fetches each provider's usage server-side and normalizes their different usage APIs into a unified `RateWindow` / `UsageSnapshot` model that the frontend renders uniformly.

> **Fully standalone subproject**: ships its own pnpm workspace and dependencies, with no coupling to the outer repository.

## Architecture

```
Frontend (Next.js App Router, React)         ← only consumes the normalized UsageSnapshot
        │ GET /api/usage  POST /api/credentials  POST /api/refresh
Backend proxy (Next route handlers, Node runtime)
        │ · Encrypted credential storage (AES-256-GCM + SQLite)
        │ · Background polling + OAuth token refresh (started by instrumentation)
        │ · Injects Authorization/Cookie/custom headers, bypassing the browser's CORS limits
        ↓ Upstream HTTPS (server-side, no CORS)
api.anthropic.com · chatgpt.com/backend-api · api.kimi.com · ...
```

**Why a backend is required**: browsers are limited by CORS, cannot read httpOnly cookies, are forbidden from setting `Cookie`/`User-Agent` headers, cannot access local credentials, and so on — so they cannot call these usage endpoints directly. All upstream requests are made from the Node server.

## Directory structure

```
quota-dashboard/
├─ packages/core/          # Provider-agnostic core (independently testable)
│  └─ src/
│     ├─ model.ts          # Unified models: RateWindow / UsageSnapshot, etc.
│     ├─ adapter.ts        # ProviderFetchStrategy / runPipeline pipeline
│     ├─ decode.ts         # Fault-tolerant decode helpers
│     ├─ http.ts           # HttpClient abstraction + Node fetch implementation
│     ├─ registry.ts       # Provider registry
│     └─ providers/        # kimi / moonshot / claude / codex
└─ apps/web/               # Next.js dashboard + backend proxy
   ├─ app/                 # Pages + API routes
   ├─ components/          # ProviderCard / RateWindowBar / forms
   └─ lib/                 # db / crypto / store / fetcher / poller
```

## Implemented providers

| Provider | Path | Credentials | Output |
|---|---|---|---|
| **Kimi** | Code API (`api.kimi.com/coding/v1/usages`) | Bearer key | Weekly usage + 5h rate window |
| **Moonshot** | balance (`api.moonshot.ai\|.cn`) | Bearer key | Balance (no window) |
| **Claude** | OAuth usage (`api.anthropic.com/api/oauth/usage`) | access token (+refresh) | 5h/7d/model/routines windows + extra spend |
| **Codex** | OAuth usage (`chatgpt.com/backend-api/wham/usage`) | access token + account id (+refresh) | 5h/7d windows + credits |

See the comment at the top of each `providers/*.ts` for how to obtain credentials. Claude/Codex tokens can be copy-pasted from your local `~/.claude/.credentials.json` and `~/.codex/auth.json`.

## Local development

```bash
cd quota-dashboard
pnpm install

# Configure environment variables
cp apps/web/.env.example apps/web/.env
# Generate the master encryption key and put it in APP_ENC_KEY
openssl rand -hex 32

pnpm dev          # http://localhost:3000
```

Open the page → click "+ Add credentials" → pick a provider, paste the key/token → save and it fetches immediately. The background poller refreshes every `POLL_INTERVAL_SECONDS` seconds.

## Configure credentials without the UI

Besides the web form, credentials can be supplied via environment variables or read directly from your local CLI credential files. `<PROVIDER>` is one of `CLAUDE` / `CODEX` / `KIMI` / `MOONSHOT`. See `apps/web/.env.example` for the full list.

**A) Inline env vars** — seeded into the DB once at startup, then behave exactly like a credential entered in the UI (token refresh persists to the DB). Good for `docker run -e`:

```bash
QUOTA_CLAUDE_BEARERTOKEN=sk-ant-oat...
QUOTA_CLAUDE_REFRESHTOKEN=sk-ant-ort...     # optional, enables auto-refresh
QUOTA_KIMI_BEARERTOKEN=sk-...
QUOTA_CODEX_JSON={"bearerToken":"...","accountId":"...","refreshToken":"..."}
```

By default a provider is only seeded when the DB has no credential for it (so a token refreshed into the DB survives restarts). Set `QUOTA_<PROVIDER>_OVERWRITE=true` to re-seed from the env on every restart.

**B) Local file source** — read fresh on **every poll**; the file is the source of truth. Point it straight at the live CLI credential file:

```bash
QUOTA_CLAUDE_FILE=/path/to/.claude/.credentials.json   # native format auto-parsed
QUOTA_CODEX_FILE=/path/to/.codex/auth.json
# QUOTA_<PROVIDER>_FILE_FORMAT=json      # if the file is raw ProviderCredentials JSON
# QUOTA_<PROVIDER>_FILE_WRITABLE=true    # allow the dashboard to refresh + rewrite the file
```

### Read-only vs read-write — which to mount?

**Read-only is the right default, and it works.** With a read-only file source the dashboard *only reads* the file each poll and **never refreshes the token itself**. That is deliberate: these refresh tokens rotate (using one invalidates the old one), so if the dashboard refreshed it would silently break the credential file that your local CLI still depends on. Instead the dashboard rides along on whatever token your CLI keeps fresh — re-reading the file each cycle picks up the CLI's refreshes automatically.

- **Read-only** (default): use it when the dashboard runs on (or alongside) a machine where the CLI is actively used and keeps the token fresh. If the access token expires while the CLI is idle, the card shows an "expired, waiting for the file to be refreshed" error until the CLI refreshes it. The dashboard never writes.
- **Read-write** (`QUOTA_<PROVIDER>_FILE_WRITABLE=true` + a writable mount): use it when the dashboard is the **sole** refresher — e.g. on a server where the CLI never runs. The dashboard then refreshes the token and writes the rotated tokens back to the file. Don't point a read-write source at a file a CLI is also refreshing, or the two will rotate each other out.

> Docker tip: bind-mount the **directory**, not the single file. A CLI refreshing its token rewrites the file via atomic rename, which a single-file bind mount won't see; mounting the parent directory makes the update visible inside the container. See `docker-compose.yml`.

## Build / deploy

```bash
pnpm build        # next build (standalone output)
pnpm start        # production mode

# Or Docker (long-lived process, supports background polling)
docker build -t quota-dashboard .
docker run -p 3000:3000 \
  -e APP_ENC_KEY=$(openssl rand -hex 32) \
  -v $(pwd)/data:/app/apps/web/data \
  quota-dashboard

# Reading your local CLI credentials directly (read-only mount of the *directory*):
docker run -p 3000:3000 \
  -e APP_ENC_KEY=$(openssl rand -hex 32) \
  -e DASHBOARD_PASSWORD=... \
  -e QUOTA_CLAUDE_FILE=/creds/claude/.credentials.json \
  -e QUOTA_CODEX_FILE=/creds/codex/auth.json \
  -v $(pwd)/data:/app/apps/web/data \
  -v "$HOME/.claude:/creds/claude:ro" \
  -v "$HOME/.codex:/creds/codex:ro" \
  quota-dashboard
```

A ready-made `docker-compose.yml` with the same mounts lives at the repo root. See [Configure credentials without the UI](#configure-credentials-without-the-ui) for the read-only vs read-write trade-off.

> When self-hosting, run it as a **long-lived process** (standalone / Docker); do not use serverless — background polling and token refresh depend on a long-lived process.

## Security notes

A set of hardening measures aimed at public deployments is built in:

- **Authentication (fail-closed)**: `middleware.ts` intercepts all pages and `/api/*`. Login requires `DASHBOARD_PASSWORD` and issues an HMAC-signed httpOnly session cookie. **When no password is set, all access is denied**, preventing an unprotected deployment. For local development you can set `AUTH_DISABLED=true` to skip login.
- **Rate limiting**: in-process per-IP rate limiting, stricter on the login path (anti-brute-force). It reads `x-forwarded-for`, so it must sit behind a reverse proxy.
- **SSRF protection**: a user-supplied Kimi `baseUrlOverride` must be a public https URL and is checked twice (literal + DNS resolution), rejecting private / loopback / cloud-metadata addresses.
- **Credential protection**: credentials are AES-256-GCM encrypted and stored in SQLite, and are **never returned to the frontend**; `/api/usage` exposes only the fields the UI needs (stripping the raw upstream response `extra`).
- **CSRF**: the session cookie uses `sameSite=lax`, so cross-site write requests carry no cookie and are blocked by default.

### Public deployment checklist (do all of these)

1. **TLS**: this service serves HTTP only and must sit behind a reverse proxy (Caddy / Nginx / Cloudflare) that terminates HTTPS — otherwise the login and credential forms go out in plaintext.
2. Set a strong `DASHBOARD_PASSWORD` and a separate `AUTH_SECRET`, and keep `AUTH_DISABLED` off.
3. Have the reverse proxy forward `X-Forwarded-For` correctly (rate limiting depends on it), and set security response headers (HSTS, etc.) at the proxy.
4. Adding a network-layer defense (Cloudflare Access / IP allowlist / Tailscale) on top is still recommended, for defense in depth.

> Residual risks: rate limiting is single-instance in-memory (switch to Redis for multiple instances); the SSRF DNS check cannot fully prevent DNS rebinding; if the host is compromised, `APP_ENC_KEY` sitting alongside the database is effectively plaintext. These are unofficial internal endpoints whose fields may drift; calls to claude.ai / chatgpt.com are ToS-sensitive — be aware of the risks.

## Adding a new provider

1. Add `xxx.ts` under `packages/core/src/providers/`, implement `ProviderFetchStrategy`, and export a `ProviderDescriptor`.
2. Register it in `providers/index.ts` and `registry.ts`.
3. Add it to the `UsageProvider` union type in `model.ts`.

No UI or backend changes are needed — form fields and card rendering are driven by descriptor metadata.

## Notes / trade-offs

- Storage uses **better-sqlite3 directly + hand-written SQL** (minimal dependencies, no migration tooling); if you need typed queries / migrations you can layer on Drizzle.
- Historical snapshots are already persisted to the `snapshot_history` table (`historyFor` in `store.ts`), which you can use to add a used-% history chart.
- The cookie-scraping paths (claude.ai / chatgpt.com web, Kimi web) are not included in this scaffold — see the upstream report; they are the most fragile and most ToS-sensitive tier, add them as needed.
