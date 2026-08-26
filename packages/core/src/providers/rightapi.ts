// GET {base}/auth/me, Authorization: Bearer <user_token> — RightAPI relay account.
// The relay meters money, not time: `balance` is prepaid credit and `upstream_limits`
// are instantaneous RPM / concurrency caps that never roll over, so this provider
// emits no RateWindows (modelling RPM as a 1-minute window would make every burst
// look like a quota reset to core/src/reset.ts).
// The response echoes the credential itself, so the raw body is redacted before it
// reaches `extra` (and note DEBUG=true logs raw bodies in apps/web/lib/fetcher.ts).

import type { ProviderDescriptor, ProviderFetchStrategy } from "../adapter";
import { RateLimitedError, UnauthorizedError, UpstreamError } from "../adapter";
import type { UsageSnapshot } from "../model";
import { num, retryAfterSeconds, safeJson } from "../decode";
import { assertSafeExternalUrl } from "../net";

const DEFAULT_BASE = "https://www.rightapi.ai";

/** Base may already include /auth or /auth/me; avoid duplicating the path segment. */
function buildUrl(override?: string): string {
  const trimmed = override?.trim();
  if (!trimmed) return `${DEFAULT_BASE}/auth/me`;
  assertSafeExternalUrl(trimmed); // SSRF: reject non-https / private-network hosts
  const base = trimmed.replace(/\/+$/, "");
  if (/\/auth\/me$/.test(base)) return base;
  if (/\/auth$/.test(base)) return `${base}/me`;
  return `${base}/auth/me`;
}

/** Error bodies are `{status, error, message, ...}`; prefer that text over the raw JSON blob. */
function errorText(body: string): string {
  const j = safeJson(body);
  const msg = typeof j?.message === "string" && j.message.trim() ? j.message.trim() : null;
  const err = typeof j?.error === "string" && j.error.trim() ? j.error.trim() : null;
  return msg ?? err ?? body.slice(0, 200);
}

interface Live {
  rpm: number;
  concurrent: number;
}

/** Sum in-flight traffic over every upstream and its per-model buckets. */
function liveTraffic(upstreams: unknown): Live {
  const live: Live = { rpm: 0, concurrent: 0 };
  if (!Array.isArray(upstreams)) return live;
  for (const u of upstreams) {
    if (!u || typeof u !== "object") continue;
    const up = u as Record<string, unknown>;
    live.rpm += num(up.current_rpm) ?? 0;
    live.concurrent += num(up.current_concurrent) ?? 0;
    for (const m of Array.isArray(up.model_limits) ? up.model_limits : []) {
      if (!m || typeof m !== "object") continue;
      const ml = m as Record<string, unknown>;
      live.rpm += num(ml.current_rpm) ?? 0;
      live.concurrent += num(ml.current_concurrent) ?? 0;
    }
  }
  return live;
}

const rightapiAccountStrategy: ProviderFetchStrategy = {
  id: "rightapi-account",
  sourceMode: "api",
  isAvailable: (c) => !!c.bearerToken,
  shouldFallback: () => false,
  async fetch(c, ctx) {
    const res = await ctx.http.get(
      buildUrl(c.baseUrlOverride),
      { Authorization: `Bearer ${c.bearerToken}`, Accept: "application/json" },
      { timeoutMs: 20_000 },
    );
    if (res.status === 401 || res.status === 403) throw new UnauthorizedError(errorText(res.body));
    if (res.status === 429) throw new RateLimitedError(retryAfterSeconds(res.headers));
    if (res.status >= 400) throw new UpstreamError(res.status, errorText(res.body));
    // An unknown-but-well-formed token gets 200 with an empty body; a valid one always
    // returns the account object. (A malformed token gets a 500 — left as an upstream error.)
    if (res.body.trim() === "") throw new UnauthorizedError("user token 无效或已轮换");
    const j = safeJson(res.body);
    if (!j || typeof j !== "object") throw new UpstreamError(res.status, "invalid JSON");
    const balance = num(j.balance);
    if (balance == null) throw new UpstreamError(res.status, "response carries no balance");

    // Currency is absent from the payload; symbol is a display choice, not upstream data.
    const sym = c.extra?.currency?.trim() || "$";
    const segments = [`Balance: ${sym}${balance.toFixed(2)}`];
    const pending = num(j.invite_rebate_pending_balance) ?? 0;
    if (pending > 0) segments.push(`待入账 ${sym}${pending.toFixed(2)}`);
    if (j.is_banned === true) segments.push("账号已封禁");
    const live = liveTraffic(j.upstream_limits);
    if (live.rpm > 0 || live.concurrent > 0) segments.push(`RPM ${live.rpm} · 并发 ${live.concurrent}`);

    const email = typeof j.email === "string" && j.email ? j.email : null;
    const username = typeof j.username === "string" && j.username ? j.username : null;
    const { user_token: _t, invite_code: _i, balance_alert_email: _e, ...account } = j;

    const snapshot: UsageSnapshot = {
      provider: "rightapi",
      primary: null,
      secondary: null,
      tertiary: null,
      identity: {
        providerID: "rightapi",
        accountEmail: email ?? username,
        loginMethod: segments.join(" · "),
      },
      dataConfidence: "exact",
      updatedAt: ctx.now.toISOString(),
      extra: { account },
    };
    return snapshot;
  },
};

export const rightapiDescriptor: ProviderDescriptor = {
  provider: "rightapi",
  label: "RightAPI (中转余额)",
  accentColor: "#f59f00",
  producesRateWindows: false,
  credentialFields: [
    {
      key: "bearerToken",
      label: "RightAPI User Token",
      required: true,
      secret: true,
      placeholder: "1a1a5b87-...",
      help: "控制台的 user_token；开启轮换后每 30 天需重新填写",
    },
    {
      key: "baseUrlOverride",
      label: "Base URL（可选）",
      required: false,
      secret: false,
      placeholder: DEFAULT_BASE,
    },
    {
      key: "extra.currency",
      label: "货币符号（可选）",
      required: false,
      secret: false,
      placeholder: "$",
      help: "接口不返回币种，仅影响显示",
    },
  ],
  resolveStrategies: () => [rightapiAccountStrategy],
};
