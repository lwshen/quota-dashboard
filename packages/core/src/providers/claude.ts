// Usage GET requires header `anthropic-beta: oauth-2025-04-20`; do NOT send anthropic-version (Admin API only).
// Token refresh uses a different host (platform.claude.com, not api.anthropic.com).

import type { FetchContext, ProviderCredentials, ProviderDescriptor, ProviderFetchStrategy, RefreshResult } from "../adapter";
import { RateLimitedError, RefreshRejectedError, UnauthorizedError, UpstreamError } from "../adapter";
import type { NamedRateWindow, ProviderCostSnapshot, RateWindow, UsageSnapshot } from "../model";
import { asRecord, clampPercent, nonEmptyString, num, parseIsoOrUnix, pick, retryAfterSeconds, safeJson, slug } from "../decode";
import { decodeRefreshResponse } from "./oauth-refresh";

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
  // Top-level named windows use `utilization`; entries in `limits` use `percent`.
  const util = num(obj.utilization) ?? num(obj.percent);
  if (util == null) return null;
  return {
    usedPercent: clampPercent(util),
    windowMinutes,
    resetsAt: parseIsoOrUnix(obj.resets_at ?? obj.resetsAt),
  };
}

function scopedWindows(limits: unknown): NamedRateWindow[] {
  if (!Array.isArray(limits)) return [];
  const seen = new Set<string>();
  const windows: NamedRateWindow[] = [];
  for (const item of limits) {
    const limit = asRecord(item);
    if (limit?.kind !== "weekly_scoped" || limit.group !== "weekly") continue;
    const model = asRecord(asRecord(limit.scope)?.model);
    const name = nonEmptyString(model?.display_name);
    const modelID = nonEmptyString(model?.id);
    const window = windowFrom(limit, 10080);
    if (!window || !name || slug(name) === "all-models" || /(^|-)all-models$/.test(slug(modelID ?? ""))) continue;
    const identity = slug(modelID ?? name);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    // Enforceable scoped limits can report is_active=false.
    windows.push({ id: `claude-weekly-scoped-${identity}`, title: `${name} (7d)`, window, usageKnown: true });
  }
  return windows;
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
    // Tag the tertiary source: sonnet and opus are distinct quotas, and comparing one
    // against the other across snapshots (e.g. in reset detection) would be meaningless.
    const sonnet = windowFrom(j.seven_day_sonnet, 10080);
    const opus = windowFrom(j.seven_day_opus, 10080);
    const tertiary = sonnet
      ? { ...sonnet, sourceKey: "seven_day_sonnet" }
      : opus
        ? { ...opus, sourceKey: "seven_day_opus" }
        : null;

    const extra: NamedRateWindow[] = [];
    const routineWin = windowFrom(pick(j, ROUTINE_KEYS), 10080);
    if (routineWin) extra.push({ id: "routines", title: "Routines (7d)", window: routineWin, usageKnown: true });
    extra.push(...scopedWindows(j.limits));

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
  if (!creds.refreshToken) throw new RefreshRejectedError("missing refresh_token");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: creds.extra?.clientId || CLIENT_ID,
  }).toString();
  const res = await ctx.http.post(
    TOKEN_URL,
    body,
    { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    { timeoutMs: 30_000, retry: false },
  );
  return { credentials: decodeRefreshResponse(res, creds, ctx.now) };
}

export const claudeDescriptor: ProviderDescriptor = {
  provider: "claude",
  label: "Claude (OAuth 订阅)",
  accentColor: "#d97757",
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
