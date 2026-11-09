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
├─ packages/core/          # Framework-free models, providers, OAuth and HTTP
│  ├─ src/providers/       # kimi / moonshot / claude / codex / grok / rightapi
│  └─ tests/               # Offline protocol and fetch tests
├─ apps/web/
│  ├─ app/                 # Pages and API routes
│  ├─ components/          # accounts / auth / dashboard / layout features
│  ├─ client/              # Browser interaction hooks
│  ├─ shared/              # Pure logic, formatting, API types and JSON import
│  ├─ runtime/             # Edge / Node configuration and session auth
│  ├─ server/              # credentials / security / storage / usage / notify
│  └─ tests/               # API, SQLite, notification and rendering tests
├─ scripts/                # Environment setup, tests and dependency checks
└─ docs/                   # Architecture guide and feature screenshots
```

See the [architecture and maintenance guide (Chinese)](./docs/architecture.zh-CN.md) for module boundaries and change locations.

## Implemented providers

| Provider     | Path                                               | Credentials                          | Output                                                               |
| ------------ | -------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| **Kimi**     | Code API (`api.kimi.com/coding/v1/usages`)         | Bearer key                           | Weekly/session quotas + monthly total; ratio pools and legacy counts |
| **Moonshot** | balance (`api.moonshot.ai\|.cn`)                   | Bearer key                           | Balance (no window)                                                  |
| **Claude**   | OAuth usage (`api.anthropic.com/api/oauth/usage`)  | access token (+refresh)              | 5h/7d/all model-scoped/routines windows + extra spend                |
| **Codex**    | OAuth usage (`chatgpt.com/backend-api/wham/usage`) | access token + account id (+refresh) | 5h/7d + Spark windows; Credits balance and workspace monthly cap     |
| **Grok**     | CLI billing proxy, with bearer gRPC-web fallback   | Grok CLI access token                | Credit usage + reset time, product breakdown, plan, prepaid balance  |
| **RightAPI** | account (`www.rightapi.ai/auth/me`)                | user token                           | Balance (no window)                                                  |

See the comment at the top of each `providers/*.ts` for how to obtain credentials. In account settings, Claude and all Codex accounts support importing a JSON file or pasting a JSON string from `~/.claude/.credentials.json` or `~/.codex/auth.json`. Full credential files, their `claudeAiOauth` / `tokens` objects, and flat token objects are supported. Imports fill the form for review before saving, including refresh tokens and Codex account IDs when present. Parsing happens in the browser (1 MB maximum); only supported credential fields are submitted when you save. Manual entry remains available.

Kimi session labels follow the API's actual duration. Missing usage stays unknown for each window independently. Claude model-scoped weekly limits are displayed even when their `is_active` flag is false; model identity keeps separate quotas from being compared as resets.

Codex credit amounts use the native **Credits** unit. Monthly caps and independent purchased balances are shown together; a repeated monthly remainder is not counted twice. When a workspace advertises spend controls but omits a usable cap, an account-scoped monthly-usage lookup runs with a six-second budget. Failure of this optional lookup preserves the main quota and balance.

Claude and all Codex accounts recognize permanent OAuth refresh failures, including nested error codes. Polling stops using the rejected credential until it is replaced; temporary failures retain the existing retry backoff. Successful renewals save rotated tokens and the server-provided expiry, with no fixed eight-day lifetime assumption for Codex.

### Grok credentials and usage

Run `grok login`, then copy the `key` for your account from `~/.grok/auth.json`
(usually under `https://auth.x.ai::<client-id>`, or the legacy `https://accounts.x.ai/sign-in` entry).
Select **Grok (SuperGrok 订阅)** in the credential form and paste it as the Access Token.
The token is a subscription login credential, not an `xai-` API key. Import `auth.json`
in the form to fill the access token, refresh token, client ID, and expiry automatically,
or enter them manually. Files are parsed in the browser; only the selected account's
required credential fields are submitted. Files containing multiple accounts require a selection.

With a refresh token and client ID, usage polling renews credentials through
`https://auth.x.ai/oauth2/token` when fewer than ten minutes remain. A 401 also triggers
one renewal and usage retry. Rotated tokens and the server-provided expiry are saved
together using the existing encryption. Access-token-only credentials remain supported
but require manual replacement when expired. Lifetimes come from the issued token,
not a fixed six-hour or seven-day assumption.

Use one refresh owner per login session: the CLI and dashboard must not independently
rotate the same refresh token. Importing creates a dashboard-managed copy; it neither
writes back to `auth.json` nor follows later CLI changes. Prefer a login session managed
exclusively by the dashboard. `invalid_grant` / `invalid_client` pauses renewal until
credentials are replaced; network failures and rate limits back off, while unexpired
access tokens can still supply usage.

The server-side HTTP pipeline reads subscription usage through these billing endpoints:

- Reads `https://cli-chat-proxy.grok.com/v1/billing?format=credits` with bearer auth and `x-xai-token-auth: xai-grok-cli`.
- Tries Grok's `GetGrokCreditsConfig` gRPC-web endpoint with the same token if billing fails or omits usage. An optional lookup has a six-second timeout and cannot discard valid proxy metadata.
- Displays missing usage as **unknown**, with any available reset time. A validated active gRPC period can establish an implicit zero.
- Shows product shares as text under the total quota, only when the complete breakdown matches that response's aggregate. Prepaid balance is separate and converted from USD cents.

This integration does not launch the Grok CLI, import browser cookies,
scan local sessions, or fetch reset coupons.
Polling and manual requests share in-flight work within one server process. Run a single
instance so separate processes cannot rotate the same credential concurrently.

Run `pnpm test` for the offline provider, OAuth, HTTP transport, and card-rendering tests, and `pnpm typecheck` for both packages.

## Local development

```bash
cd quota-dashboard
pnpm install

# Generate apps/web/.env for development: fresh APP_ENC_KEY / AUTH_SECRET /
# DASHBOARD_PASSWORD, plus AUTH_DISABLED=true so login is skipped.
# Safe to re-run — an existing .env is kept (add `-- --force` to regenerate).
pnpm setup:env

pnpm dev          # http://localhost:3000
```

Prefer to do it by hand? `cp apps/web/.env.example apps/web/.env`, then put an `openssl rand -hex 32` value in `APP_ENC_KEY`.

## Multiple accounts

Sign in as an administrator, open **账号管理** (Accounts), and choose **新增账号** (Add account). Select a provider, enter an alias, optionally choose an existing group or type a new one, then configure credentials. Any provider can have multiple accounts; Codex is no longer limited to two slots. Aliases and groups accept up to 80 characters. Duplicate aliases are allowed; independent IDs distinguish accounts.

The dashboard groups account cards, placing accounts without a group under **未分组** (Ungrouped). Account details support renaming, regrouping, credential configuration, and targeted refreshes. Filter the list by group, missing credentials, or fetch errors. Aliases and groups appear on the public read-only dashboard; emails and balances retain their administrator-only visibility.

Credentials, OAuth renewal state, usage, history, and notification cooldowns are isolated per account. Renaming or regrouping preserves these records. Disabling an account hides and stops polling/notifying only that account while retaining credentials and history; saving credentials does not re-enable it. Deleting requires confirmation and removes only the selected account's data. `ENABLE_POLLER=false` still disables background polling globally.

Existing stored channels migrate automatically. Legacy `codex` / `codex2` retain their storage IDs and become ordinary Codex accounts with default aliases **Codex** / **Codex #2**. Other stored channels become accounts as well. Encrypted credential bytes, history, enabled states, and notification records are preserved without re-importing credentials. Migration is idempotent and does not recreate deleted accounts. Fresh databases have no fixed account slots.

`GET/POST/PATCH/DELETE /api/accounts` is administrator-only. Credential, targeted-refresh, and history requests use the dashboard account's `accountId`, which is separate from the upstream ChatGPT Account ID credential field. `GET /api/providers` lists provider templates without a Codex #2 template. Legacy `provider` request parameters remain compatible with migrated storage IDs.

Enter the complete credentials and save directly; there is no save-mode selector. Saving an existing provider replaces its credentials, clears optional values left blank, and removes previous usage snapshots and history to avoid mixing tokens from different accounts. Unsaved input is cleared when switching providers, returning to the list, or closing the panel. Credentials are never written to browser storage.

Disabled providers offer Save credentials without fetching, followed by **启用并获取用量** (Enable and fetch usage). Enabled providers also offer **重新获取用量** (Fetch usage again), so a failed fetch can be retried without resubmitting credentials.

To inspect a provider response while debugging, set `DEBUG=true`. Raw quota API response bodies are written to the **server console** during each fetch and are never returned by the dashboard API. Do not enable this in production, because responses may contain account data.

## Usage history

Choose **历史曲线** (History) on an account card to view the past 24 hours, 7 days, or 30 days. Select a quota window to see its latest recorded value, minimum, and maximum. Markers identify detected quota resets. Hover over the chart, or focus it and use the arrow keys, to inspect sample times and values. Times use the browser's local timezone.

Charts read existing `snapshot_history` records without reconfiguring credentials. Unknown usage, missing windows, and long collection gaps break the line; different model identities and window durations stay separate. Longer ranges retain endpoints, minima, maxima, and reset points in time buckets instead of sending every raw snapshot to the browser. A single observation appears as a point; ranges without usable observations show an empty state.

Balances and period spend are visible to administrators only, in each provider's original unit, including Credits and legacy Moonshot / RightAPI balance snapshots. Anonymous visitors can view quota percentages. `GET /api/history?accountId=<account-id>&range=24h` accepts `24h`, `7d`, or `30d`, excludes account identity and raw upstream responses, and rejects disabled providers.

## Quota-reset notifications

The poller can push a message when a rate window gets fresh quota — e.g. a 5-hour window that had hit 100% rolls over, or the weekly window resets. Detection compares consecutive snapshots server-side (a sharp used% drop on the same window), so it works for every provider that reports rate windows.

Feishu (Lark) group bot is built in:

1. In a Feishu group: settings → Bots → add a **Custom Bot**, copy its webhook URL (optionally enable signature verification and copy the secret).
2. Set the env vars:

```bash
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
FEISHU_WEBHOOK_SECRET=   # only if signature verification is enabled
NOTIFY_MIN_USED_PERCENT=80   # only notify windows that had reached this used%; 0 = every reset (weekly windows always notify)
```

3. Verify delivery with `POST /api/notify/test` (requires a logged-in session; the dashboard cookie works: `curl -X POST -b "qd_session=..." http://localhost:3000/api/notify/test`).

When channels are configured, a one-shot startup message is also sent as the service boots (useful as a restart/liveness signal).

Reset times in messages use the server timezone — set `TZ` (e.g. `TZ=Asia/Shanghai`) in your deployment. Other channels (Telegram, Slack, ...) can be added by implementing the `NotifyChannel` interface in `apps/web/server/notify/` and registering it in `notify/index.ts`.

## Low-quota and provider-health alerts

With the Feishu bot configured, background polling and manual refreshes also check these conditions by default:

- **Low quota:** warn at **80%** and **95%** used, for known rate windows and finite period quotas. Unknown usage, unlimited quotas, and product shares do not trigger alerts. Model identities, window durations, and balance units remain separate.
- **Fetch failures:** warn after **3 consecutive failures**. A successful fetch resets the counter. Upstream rate limits count as fetch failures.
- **Credential problems:** immediately warn when a usage endpoint rejects credentials or OAuth renewal is permanently rejected, with instructions to check the token/permissions or sign in and import credentials again. Successful automatic renewal and temporary renewal errors that still allow usage retrieval do not trigger credential warnings.
- **Stale data:** while the background poller is running, warn after **30 minutes** without a successful fetch, with an effective minimum of three polling intervals. An active fetch/credential warning suppresses a duplicate stale warning. The dashboard process must still be running for this check.
- **Recovery:** send one recovery message after the next successful fetch, only to notification channels that received a provider-health warning.

Warnings raised by one provider observation are grouped into one message. An unresolved warning repeats at most every **6 hours** per metric and notification channel; crossing a higher percentage threshold or escalating to a credential problem alerts immediately. Briefly falling below a threshold and crossing again remains subject to the cooldown. SQLite's `notification_alert_state` table persists failure counts, cooldowns, and per-channel delivery state across restarts. Failed sends are retried on later observations rather than marked delivered.

Balance warnings are opt-in, with separate thresholds in each provider's original unit. Accounts of the same provider share its threshold, with independent notification cooldowns. Codex uses Credits; Moonshot follows its configured region. No currency conversion is performed:

```dotenv
NOTIFY_ALERTS_ENABLED=true
NOTIFY_USAGE_THRESHOLDS=80,95
NOTIFY_BALANCE_THRESHOLDS={"moonshot":5,"rightapi":5,"codex":100}
NOTIFY_FAILURE_THRESHOLD=3
NOTIFY_COOLDOWN_SECONDS=21600
NOTIFY_STALE_SECONDS=1800
NOTIFY_RECOVERY=true
DASHBOARD_URL=https://quota.example.com
```

An empty `NOTIFY_USAGE_THRESHOLDS` disables percentage warnings; `NOTIFY_BALANCE_THRESHOLDS={}` disables balance warnings. Balances at or below their threshold trigger warnings, including zero and negative values. `NOTIFY_ALERTS_ENABLED=false` disables these new alerts while retaining reset/startup/test notifications. `NOTIFY_RECOVERY=false` disables recovery notices only. Restart after changing environment settings.

Unconfigured and disabled providers do not alert. Disabling a provider, deleting credentials, or replacing the complete credential set clears its alert state. Same-account manual credential updates re-arm health warnings while retaining quota cooldowns; automatic OAuth rotations retain alert state. Notifications include provider names, usage, and fixed action guidance, without account identities, tokens, or raw upstream error bodies. The optional `DASHBOARD_URL` adds a link to the dashboard and is never used as a server-side request destination.

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
```

> When self-hosting, run it as a **long-lived process** (standalone / Docker); do not use serverless — background polling and token refresh depend on a long-lived process.

## Security notes

A set of hardening measures aimed at public deployments is built in:

- **Authentication (fail-closed)**: `middleware.ts` intercepts all pages and `/api/*`. Login requires `DASHBOARD_PASSWORD` and issues an HMAC-signed httpOnly session cookie. **When no password is set, all access is denied**, preventing an unprotected deployment. For local development you can set `AUTH_DISABLED=true` to skip login.
- **Rate limiting**: in-process per-IP rate limiting, stricter on the login path (anti-brute-force). It reads `x-forwarded-for`, so it must sit behind a reverse proxy.
- **SSRF protection**: a user-supplied Kimi / RightAPI `baseUrlOverride` must be a public https URL and is checked twice (literal + DNS resolution), rejecting private / loopback / cloud-metadata addresses.
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
- Historical snapshots are persisted to `snapshot_history`; reset notifications use recent snapshots, while history charts stream a time range and retain key samples.
- The cookie-scraping paths (claude.ai / chatgpt.com web, Kimi web) are not included in this scaffold — see the upstream report; they are the most fragile and most ToS-sensitive tier, add them as needed.
