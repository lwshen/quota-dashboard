# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (via corepack; pinned `pnpm@11.9.0`), Node **>= 22**. All commands run from the repo root.

```bash
pnpm install            # install workspace deps
pnpm setup:env          # generate apps/web/.env for local dev (idempotent; -- --force to regenerate)
pnpm dev                # next dev for @quota/web → http://localhost:3000
pnpm build              # next build (standalone output)
pnpm start              # run the standalone production server
pnpm typecheck          # tsc --noEmit across all packages (pnpm -r typecheck)
pnpm test               # offline core provider and HTTP transport tests (Node test runner)
```

Core tests live in `packages/core/tests/*.test.cjs`. `pnpm test` compiles core to a temporary directory and runs Node's built-in test runner; no live credentials are needed. There is no linter/formatter configured. Run `pnpm typecheck` and relevant tests for provider changes.

Before running locally, run `pnpm setup:env` (`scripts/setup-env.mjs`): it copies `apps/web/.env.example` → `apps/web/.env`, generates `APP_ENC_KEY` / `AUTH_SECRET` / `DASHBOARD_PASSWORD`, and sets `AUTH_DISABLED=true` so login is skipped. It never overwrites an existing `.env` unless given `--force` (which first writes a `.env.bak`). To do it by hand instead: copy the example and set `APP_ENC_KEY` (`openssl rand -hex 32`).

## Architecture

A pnpm-workspace monorepo with two packages:

- **`packages/core`** (`@quota/core`) — provider-agnostic, framework-free TypeScript. Consumed **directly from `src/` TypeScript source** (no build step): `apps/web` lists it in `transpilePackages`, so Next.js compiles it. Don't add a build/`dist` step for core.
- **`apps/web`** (`@quota/web`) — Next.js 15 App Router app **plus** the backend proxy (route handlers run in the Node runtime).

### Why a backend exists (the central design constraint)

The browser cannot call the upstream usage endpoints directly (CORS, can't read httpOnly cookies, forbidden from setting `Cookie`/`User-Agent`, no access to local credentials). **Every upstream request is made server-side** from `apps/web` route handlers / the poller, which inject `Authorization`/`Cookie`/custom headers. The frontend only ever consumes the normalized model.

### The provider pipeline (how data is fetched)

Each provider is a **`ProviderDescriptor`** that resolves to an ordered list of **`ProviderFetchStrategy`**. `runPipeline` (`core/src/adapter.ts`) tries strategies in order, returns on first success, and only falls back to the next when `strategy.shouldFallback(err)` is true (typically only auth errors — see `isAuthError`). Results from any provider are normalized into the shared model in **`core/src/model.ts`**: `UsageSnapshot` (primary/secondary/tertiary `RateWindow` lanes + extras), where e.g. `RateWindow.usedPercent` is _used_ (not remaining) and a spend `limit` of `0` means unlimited/unknown. Read `model.ts` before touching any provider — the field semantics are load-bearing and not obvious.

### Adding a provider

1. Add `packages/core/src/providers/<name>.ts` implementing `ProviderFetchStrategy` and exporting a `ProviderDescriptor`.
2. Register it in `providers/index.ts` and `registry.ts` (`DESCRIPTORS`).
3. Add the name to the `UsageProvider` union in `model.ts`.

UI and backend use provider descriptor metadata. The account registry stores independent IDs, aliases, groups and enabled states; many accounts can share one provider descriptor. `codex2` is a legacy compatibility alias, excluded from `listDescriptors()`.

### Request/data flow in `apps/web`

- `middleware.ts` gates **all** pages and `/api/*` (auth + per-IP rate limit) before anything else runs.
- `GET/POST/PATCH/DELETE /api/accounts` → administrator-only account CRUD; provider is immutable, alias/group changes preserve credentials and history.
- `POST /api/credentials` → validates fields per descriptor, SSRF-checks any `baseUrlOverride`, encrypts and stores the credential, then fetches once immediately.
- `lib/fetcher.ts` (`fetchAndStore`) → loads decrypted creds, runs `runPipeline`, handles OAuth token refresh, persists the snapshot via `lib/store.ts`. Requests and in-flight work are keyed by dashboard account ID; provider adapters are selected from the credential record's provider.
- `lib/poller.ts` (`startPoller`) → background loop every `POLL_INTERVAL_SECONDS`. Started by `instrumentation.ts` **only when `NEXT_RUNTIME === "nodejs"`** (not in the edge runtime).
- `GET /api/usage` → returns stored snapshots with UI-safe fields only (raw upstream `extra` is stripped).
- `lib/notify/` → quota-reset, low-quota, credential/fetch-failure, stale-data, and recovery notifications. `fetchAndStore` invokes detection **before** `saveSnapshot`; fetch issues are typed in core, never classified by matching raw error strings. `notify/alerts.ts` groups warnings and persists per-channel cooldowns/delivery reservations in `notification_alert_state`. The poller also checks stale data. Channels implement `NotifyChannel` and are registered in `notify/index.ts` — Feishu webhook is the only built-in. `POST /api/notify/test` sends a test message.

## Conventions & gotchas

- **`lib/auth.ts` runs in both the edge (middleware) and Node (route) runtimes**, so it uses only Web Crypto / `btoa` / `TextEncoder` — do not introduce Node-only APIs there. Sessions are stateless: an expiry signed with HMAC-SHA256 in an httpOnly cookie.
- **`better-sqlite3` is a native module**: it's in `serverExternalPackages` (not bundled) and `onlyBuiltDependencies` (pnpm builds it; `sharp` is disabled). Storage is hand-written SQL via better-sqlite3. `db.ts` idempotently migrates legacy slots into `accounts`; legacy `provider` columns in credential/snapshot/history/alert tables now store account IDs. `codex2` snapshots normalize to provider `codex` when read, without rewriting history or ciphertext. Keep these storage keys separate from `UsageSnapshot.provider` and the upstream ChatGPT Account ID credential field.
- **SSRF protection is two layers**: `core/src/net.ts` does synchronous literal checks (https-only, no userinfo, reject private/loopback/link-local/CGNAT/cloud-metadata IPs); `apps/web/lib/ssrf.ts` adds DNS resolution. Known limitation: the literal-only check at fetch time leaves a TOCTOU / DNS-rebinding gap (validation isn't pinned to the connecting IP).
- **Auth is fail-closed**: if `DASHBOARD_PASSWORD` is unset, `middleware.ts` blocks everything. `AUTH_DISABLED=true` is local-dev only.
- **Credentials are AES-256-GCM encrypted (`lib/crypto.ts`) and never returned to the frontend.** `APP_ENC_KEY` is the master key.
- **Comment language**: code comments are English-only and kept minimal (explain _why_, not _what_). Note that user-facing UI text (in `.tsx`) is intentionally Chinese, and some thrown error-message strings are Chinese — these are product content, not comments; do not "translate" string literals when editing comments.

## Environment variables

Defined and validated in `apps/web/lib/env.ts`; documented in `apps/web/.env.example`. Required: `APP_ENC_KEY`; `DASHBOARD_PASSWORD` (required for any public deployment). Optional: `AUTH_SECRET` (falls back to `APP_ENC_KEY`), `AUTH_DISABLED`, `DATABASE_PATH`, `POLL_INTERVAL_SECONDS` (default 300, floor 60), `ENABLE_POLLER`, `FEISHU_WEBHOOK_URL` / `FEISHU_WEBHOOK_SECRET` / `NOTIFY_MIN_USED_PERCENT`. Alert settings: `NOTIFY_ALERTS_ENABLED`, `NOTIFY_USAGE_THRESHOLDS` (80,95), `NOTIFY_BALANCE_THRESHOLDS` (opt-in per-provider JSON map), `NOTIFY_FAILURE_THRESHOLD` (3), `NOTIFY_COOLDOWN_SECONDS` (21600), `NOTIFY_STALE_SECONDS` (1800, minimum three poll intervals), `NOTIFY_RECOVERY`, and optional `DASHBOARD_URL`. An unset webhook disables all notifications.

## Deployment

Self-host as a **long-lived process** (standalone server / Docker) — background polling and token refresh need a persistent process, so serverless won't work. The root `Dockerfile` is multi-stage and outputs the Next.js standalone server (`node apps/web/server.js`, port 3000); `apps/web/data` holds the SQLite DB and should be a volume. `.github/workflows/docker-image.yml` builds and publishes the image to GHCR on pushes to `main`. Put the service behind a TLS-terminating reverse proxy that forwards `X-Forwarded-For` (rate limiting depends on it). See `README.md` (English) / `README.zh-CN.md` (中文) for the full security/deployment checklist.
