// Usage GET requires header `anthropic-beta: oauth-2025-04-20`; do NOT send anthropic-version (Admin API only).
// Token refresh uses a different host (platform.claude.com, not api.anthropic.com).

import type { FetchContext, ProviderCredentials, ProviderDescriptor, ProviderFetchStrategy, RefreshResult } from "../adapter";
import { RateLimitedError, UnauthorizedError, UpstreamError } from "../adapter";
import type { NamedRateWindow, ProviderCostSnapshot, RateWindow, UsageSnapshot } from "../model";
import { clampPercent, num, parseIsoOrUnix, pick, retryAfterSeconds, safeJson } from "../decode";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const BETA = "oauth-2025-04-20";
const USER_AGENT = "claude-code/2.1.0";

// Routines window key varies across API versions; try each in order.
const ROUTINE_KEYS = [
  "seven_day_routines",
  "seven_day_claude_routines",
  "claude_routines",
  "routines",
  "routine",
  "seven_day_cowork",
  "cowork",
];

function windowFrom(node: unknown, windowMinutes: number | null): RateWindow | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  const util = num(obj.utilization);
  if (util == null) return null;
  return {
    usedPercent: clampPercent(util),
    windowMinutes,
    resetsAt: parseIsoOrUnix(obj.resets_at ?? obj.resetsAt),
  };
}

const claudeOAuthStrategy: ProviderFetchStrategy = {
  id: "claude-oauth",
  sourceMode: "oauth",
  isAvailable: (c) => !!c.bearerToken,
  shouldFallback: () => false,
  async fetch(c, ctx) {
    const res = await ctx.http.get(
      USAGE_URL,
      {
        Authorization: `Bearer ${c.bearerToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": BETA,
        "User-Agent": USER_AGENT,
      },
      { timeoutMs: 30_000 },
    );
    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 429) throw new RateLimitedError(retryAfterSeconds(res.headers));
    if (res.status >= 400) throw new UpstreamError(res.status, res.body.slice(0, 200));
    const j = safeJson(res.body);
    if (!j) throw new UpstreamError(res.status, "invalid JSON");

    const primary = windowFrom(j.five_hour, 300);
    const secondary = windowFrom(j.seven_day, 10080);
    const tertiary = windowFrom(j.seven_day_sonnet, 10080) ?? windowFrom(j.seven_day_opus, 10080);

    const extra: NamedRateWindow[] = [];
    const routineWin = windowFrom(pick(j, ROUTINE_KEYS), 10080);
    if (routineWin) extra.push({ id: "routines", title: "Routines (7d)", window: routineWin, usageKnown: true });

    let cost: ProviderCostSnapshot | null = null;
    const eu = j.extra_usage;
    if (eu && eu.is_enabled) {
      const usedCredits = num(eu.used_credits) ?? 0;
      const monthlyLimit = num(eu.monthly_limit) ?? num(eu.monthly_credit_limit) ?? 0;
      cost = {
        used: usedCredits / 100, // credits are in cents
        limit: monthlyLimit / 100,
        currencyCode: typeof eu.currency === "string" ? eu.currency : "USD",
        period: "Monthly extra usage",
      };
    }

    const snapshot: UsageSnapshot = {
      provider: "claude",
      primary,
      secondary,
      tertiary,
      extraRateWindows: extra.length ? extra : null,
      providerCost: cost,
      dataConfidence: primary || secondary ? "exact" : "unknown",
      updatedAt: ctx.now.toISOString(),
    };
    return snapshot;
  },
};

async function refresh(creds: ProviderCredentials, ctx: FetchContext): Promise<RefreshResult> {
  if (!creds.refreshToken) throw new UnauthorizedError("missing refresh_token");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: creds.extra?.clientId || CLIENT_ID,
  }).toString();
  const res = await ctx.http.post(
    TOKEN_URL,
    body,
    { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    { timeoutMs: 30_000 },
  );
  const j = safeJson(res.body) ?? {};
  if (res.status >= 400) {
    if (j.error === "invalid_grant") throw new UnauthorizedError("invalid_grant: re-login required");
    throw new UpstreamError(res.status, String(j.error ?? "refresh failed"));
  }
  const expiresAt = j.expires_in
    ? new Date(ctx.now.getTime() + Number(j.expires_in) * 1000).toISOString()
    : null;
  return {
    credentials: {
      ...creds,
      bearerToken: j.access_token ?? creds.bearerToken,
      refreshToken: j.refresh_token ?? creds.refreshToken,
      expiresAt,
    },
  };
}

export const claudeDescriptor: ProviderDescriptor = {
  provider: "claude",
  label: "Claude (OAuth 订阅)",
  producesRateWindows: true,
  credentialFields: [
    {
      key: "bearerToken",
      label: "OAuth Access Token",
      required: true,
      secret: true,
      placeholder: "sk-ant-oat...",
      help: "~/.claude/.credentials.json 里的 accessToken",
    },
    {
      key: "refreshToken",
      label: "Refresh Token（可选，用于自动刷新）",
      required: false,
      secret: true,
      placeholder: "sk-ant-ort...",
    },
  ],
  resolveStrategies: () => [claudeOAuthStrategy],
  refresh,
};
