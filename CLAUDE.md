# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (via corepack; pinned `pnpm@11.9.0`), Node **>= 22**. All commands run from the repo root.

```bash
pnpm install            # install workspace deps
pnpm dev                # next dev for @quota/web → http://localhost:3000
pnpm build              # next build (standalone output)
pnpm start              # run the standalone production server
pnpm typecheck          # tsc --noEmit across all packages (pnpm -r typecheck)
```

There is **no test suite and no linter/formatter configured** — `pnpm typecheck` is the only automated gate. Don't invent `test`/`lint` commands; if you add tests, wire up the tooling first.

Before running locally, copy `apps/web/.env.example` → `apps/web/.env` and set `APP_ENC_KEY` (`openssl rand -hex 32`). For local dev you can set `AUTH_DISABLED=true` to skip login.

## Architecture

A pnpm-workspace monorepo with two packages:

- **`packages/core`** (`@quota/core`) — provider-agnostic, framework-free TypeScript. Consumed **directly from `src/` TypeScript source** (no build step): `apps/web` lists it in `transpilePackages`, so Next.js compiles it. Don't add a build/`dist` step for core.
- **`apps/web`** (`@quota/web`) — Next.js 15 App Router app **plus** the backend proxy (route handlers run in the Node runtime).

### Why a backend exists (the central design constraint)

The browser cannot call the upstream usage endpoints directly (CORS, can't read httpOnly cookies, forbidden from setting `Cookie`/`User-Agent`, no access to local credentials). **Every upstream request is made server-side** from `apps/web` route handlers / the poller, which inject `Authorization`/`Cookie`/custom headers. The frontend only ever consumes the normalized model.

### The provider pipeline (how data is fetched)

Each provider is a **`ProviderDescriptor`** that resolves to an ordered list of **`ProviderFetchStrategy`**. `runPipeline` (`core/src/adapter.ts`) tries strategies in order, returns on first success, and only falls back to the next when `strategy.shouldFallback(err)` is true (typically only auth errors — see `isAuthError`). Results from any provider are normalized into the shared model in **`core/src/model.ts`**: `UsageSnapshot` (primary/secondary/tertiary `RateWindow` lanes + extras), where e.g. `RateWindow.usedPercent` is *used* (not remaining) and a spend `limit` of `0` means unlimited/unknown. Read `model.ts` before touching any provider — the field semantics are load-bearing and not obvious.

### Adding a provider

1. Add `packages/core/src/providers/<name>.ts` implementing `ProviderFetchStrategy` and exporting a `ProviderDescriptor`.
2. Register it in `providers/index.ts` and `registry.ts` (`DESCRIPTORS`).
3. Add the name to the `UsageProvider` union in `model.ts`.

UI and backend need no changes — credential form fields and card rendering are driven by descriptor metadata.

### Request/data flow in `apps/web`

- `middleware.ts` gates **all** pages and `/api/*` (auth + per-IP rate limit) before anything else runs.
- `POST /api/credentials` → validates fields per descriptor, SSRF-checks any `baseUrlOverride`, encrypts and stores the credential, then fetches once immediately.
- `lib/fetcher.ts` (`fetchAndStore`) → loads decrypted creds, runs `runPipeline`, handles OAuth token refresh, persists the snapshot via `lib/store.ts`.
- `lib/extCreds.ts` → credentials configured via `QUOTA_<PROVIDER>_*` env. Two paths: **inline** vars are seeded into the DB at startup (`seedCredentialsFromEnv`, called from `instrumentation.ts`) and then behave like UI-entered creds; a **file source** (`QUOTA_<P>_FILE`) is *live* — `fetchAndStore` re-reads it every poll, the file (not the DB) is the source of truth, and it takes precedence over everything. Read-only file sources never refresh/rotate (would invalidate the owner CLI's refresh token); only `QUOTA_<P>_FILE_WRITABLE=true` enables refresh + write-back. Native file shapes are parsed by the descriptor's `parseCredentialFile`/`serializeCredentialFile` (provider knowledge stays in core).
- `lib/poller.ts` (`startPoller`) → background loop every `POLL_INTERVAL_SECONDS`. Started by `instrumentation.ts` **only when `NEXT_RUNTIME === "nodejs"`** (not in the edge runtime).
- `GET /api/usage` → returns stored snapshots with UI-safe fields only (raw upstream `extra` is stripped).

## Conventions & gotchas

- **`lib/auth.ts` runs in both the edge (middleware) and Node (route) runtimes**, so it uses only Web Crypto / `btoa` / `TextEncoder` — do not introduce Node-only APIs there. Sessions are stateless: an expiry signed with HMAC-SHA256 in an httpOnly cookie.
- **`better-sqlite3` is a native module**: it's in `serverExternalPackages` (not bundled) and `onlyBuiltDependencies` (pnpm builds it; `sharp` is disabled). Storage is hand-written SQL via better-sqlite3 — there is no ORM or migration tooling. History is kept in the `snapshot_history` table.
- **SSRF protection is two layers**: `core/src/net.ts` does synchronous literal checks (https-only, no userinfo, reject private/loopback/link-local/CGNAT/cloud-metadata IPs); `apps/web/lib/ssrf.ts` adds DNS resolution. Known limitation: the literal-only check at fetch time leaves a TOCTOU / DNS-rebinding gap (validation isn't pinned to the connecting IP).
- **Auth is fail-closed**: if `DASHBOARD_PASSWORD` is unset, `middleware.ts` blocks everything. `AUTH_DISABLED=true` is local-dev only.
- **Credentials are AES-256-GCM encrypted (`lib/crypto.ts`) and never returned to the frontend.** `APP_ENC_KEY` is the master key.
- **Comment language**: code comments are English-only and kept minimal (explain *why*, not *what*). Note that user-facing UI text (in `.tsx`) is intentionally Chinese, and some thrown error-message strings are Chinese — these are product content, not comments; do not "translate" string literals when editing comments.

## Environment variables

Defined and validated in `apps/web/lib/env.ts`; documented in `apps/web/.env.example`. Required: `APP_ENC_KEY`; `DASHBOARD_PASSWORD` (required for any public deployment). Optional: `AUTH_SECRET` (falls back to `APP_ENC_KEY`), `AUTH_DISABLED`, `DATABASE_PATH`, `POLL_INTERVAL_SECONDS` (default 300, floor 60 — the usage endpoints rate-limit faster polling), `ENABLE_POLLER`.

Per-provider credential config (parsed in `lib/extCreds.ts`, not `env.ts`): `QUOTA_<PROVIDER>_BEARERTOKEN`/`_REFRESHTOKEN`/`_ACCOUNTID`/`_REGION`/`_BASEURLOVERRIDE`/`_EXPIRESAT`, `_JSON`, `_EXTRA_<KEY>`, `_MODE`, `_OVERWRITE` (inline → DB seed); `_FILE`, `_FILE_FORMAT` (`native`|`json`), `_FILE_WRITABLE` (live file source). `<PROVIDER>` = `CLAUDE`|`CODEX`|`KIMI`|`MOONSHOT`.

## Deployment

Self-host as a **long-lived process** (standalone server / Docker) — background polling and token refresh need a persistent process, so serverless won't work. The root `Dockerfile` is multi-stage and outputs the Next.js standalone server (`node apps/web/server.js`, port 3000); `apps/web/data` holds the SQLite DB and should be a volume. `.github/workflows/docker-image.yml` builds and publishes the image to GHCR on pushes to `main`. Put the service behind a TLS-terminating reverse proxy that forwards `X-Forwarded-For` (rate limiting depends on it). See `README.md` (English) / `README.zh-CN.md` (中文) for the full security/deployment checklist.
