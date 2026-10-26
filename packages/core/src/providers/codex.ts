// GET usage requires headers: Authorization: Bearer <access_token>, User-Agent, ChatGPT-Account-Id: <account_id>.
// Window role keyed by windowMinutes: 300=session(primary), 10080=weekly(secondary).
// Storage is keyed by provider id, so a second ChatGPT account gets its own slot ("codex2")
// built from the same implementation — see makeCodexDescriptor at the bottom.

import type { CredentialField, FetchContext, ProviderCredentials, ProviderDescriptor, ProviderFetchStrategy, RefreshResult } from "../adapter";
import { RateLimitedError, RefreshRejectedError, UnauthorizedError, UpstreamError } from "../adapter";
import type { NamedRateWindow, RateWindow, UsageProvider, UsageSnapshot } from "../model";
import { asRecord, clampPercent, nonEmptyString, num, parseIsoOrUnix, retryAfterSeconds, safeJson, slug } from "../decode";
import { codexCredits } from "./codex-credits";
import { decodeRefreshResponse } from "./oauth-refresh";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// Identify as the Codex CLI (its originator is codex_cli_rs); the endpoint doesn't validate the value.
const USER_AGENT = "codex_cli_rs/0.142.4";

interface WindowParsed {
  window: RateWindow;
  minutes: number | null;
}

function windowFrom(node: unknown): WindowParsed | null {
  const obj = asRecord(node);
  if (!obj) return null;
  const used = num(obj.used_percent);
  if (used == null) return null;
  const seconds = num(obj.limit_window_seconds);
  const minutes = seconds != null && seconds >= 60 ? Math.floor(seconds / 60) : null;
  return {
    window: {
      usedPercent: clampPercent(used),
      windowMinutes: minutes,
      resetsAt: parseIsoOrUnix(obj.reset_at ?? obj.resets_at),
    },
    minutes,
  };
}

function additionalWindows(value: unknown): NamedRateWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: NamedRateWindow[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const entry = asRecord(item);
    const rate = asRecord(entry?.rate_limit);
    if (!rate) continue;
    const name = nonEmptyString(entry?.limit_name);
    const feature = nonEmptyString(entry?.metered_feature);
    const spark = [name, feature].some((label) => label?.toLowerCase().includes("spark"));
    const primary = windowFrom(rate.primary_window);
    const secondary = windowFrom(rate.secondary_window);
    const candidates = spark ? [primary, secondary] : [primary ?? secondary];
    for (const [index, parsed] of candidates.entries()) {
      if (!parsed) continue;
      const weekly = parsed.minutes != null && parsed.minutes >= 6 * 1440
        ? true : parsed.minutes != null && parsed.minutes <= 360 ? false : index === 1;
      const identity = slug(feature ?? name ?? "");
      const id = spark ? (weekly ? "codex-spark-weekly" : "codex-spark") : `codex-${identity}`;
      if ((!spark && !identity) || seen.has(id)) continue;
      seen.add(id);
      windows.push({
        id, title: spark ? (weekly ? "Codex Spark (7d)" : "Codex Spark (5h)") : name ?? feature!,
        window: parsed.window, usageKnown: true,
      });
    }
  }
  return windows;
}

function makeCodexOAuthStrategy(provider: UsageProvider): ProviderFetchStrategy {
  return {
    id: `${provider}-oauth`,
    sourceMode: "oauth",
    isAvailable: (c) => !!c.bearerToken,
    shouldFallback: () => false,
    async fetch(c, ctx) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${c.bearerToken}`,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      };
      if (c.accountId) headers["ChatGPT-Account-Id"] = c.accountId;

      const res = await ctx.http.get(USAGE_URL, headers, { timeoutMs: 30_000 });
      if (res.status === 401) throw new UnauthorizedError();
      if (res.status === 429) throw new RateLimitedError(retryAfterSeconds(res.headers));
      if (res.status >= 400) throw new UpstreamError(res.status, res.body.slice(0, 200));
      const j = asRecord(safeJson(res.body));
      if (!j) throw new UpstreamError(res.status, "invalid JSON");

      const rl = (j.rate_limit ?? {}) as Record<string, unknown>;
      const a = windowFrom(rl.primary_window);
      const b = windowFrom(rl.secondary_window);
      let primary: RateWindow | null = a?.window ?? null;
      let secondary: RateWindow | null = b?.window ?? null;
      // Shorter window = primary(session), longer = secondary(weekly).
      if (a && b && (a.minutes ?? 0) > (b.minutes ?? 0)) {
        primary = b.window;
        secondary = a.window;
      }

      const extra = additionalWindows(j.additional_rate_limits);
      const cost = await codexCredits(j, c.accountId, headers, ctx);

      const planType = typeof j.plan_type === "string" ? j.plan_type : null;
      const resetCredits = asRecord(j.rate_limit_reset_credits);
      const resetCount = num(resetCredits?.available_count);
      const applicableResetCount = num(resetCredits?.applicable_available_count);
      const identityDetails = [
        planType ? `Plan: ${planType}` : null,
        resetCount != null ? `重置次数: ${resetCount}` : null,
        applicableResetCount != null ? `当前可用: ${applicableResetCount}` : null,
      ].filter((detail): detail is string => detail != null);
      const snapshot: UsageSnapshot = {
        provider,
        primary,
        secondary,
        tertiary: null,
        extraRateWindows: extra.length ? extra : null,
        providerCost: cost,
        identity: identityDetails.length ? { providerID: provider, loginMethod: identityDetails.join(" · ") } : null,
        dataConfidence: primary || secondary || extra.length || cost ? "exact" : "unknown",
        updatedAt: ctx.now.toISOString(),
      };
      return snapshot;
    },
  };
}

async function refresh(creds: ProviderCredentials, ctx: FetchContext): Promise<RefreshResult> {
  if (!creds.refreshToken) throw new RefreshRejectedError("missing refresh_token");
  const body = JSON.stringify({
    client_id: creds.extra?.clientId || CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    scope: "openid profile email",
  });
  const res = await ctx.http.post(
    TOKEN_URL,
    body,
    { "Content-Type": "application/json", Accept: "application/json" },
    { timeoutMs: 30_000, retry: false },
  );
  return { credentials: decodeRefreshResponse(res, creds, ctx.now) };
}

const CREDENTIAL_FIELDS: CredentialField[] = [
  {
    key: "bearerToken",
    label: "Access Token",
    required: true,
    secret: true,
    placeholder: "...",
    help: "~/.codex/auth.json 里的 tokens.access_token",
  },
  {
    key: "accountId",
    label: "ChatGPT Account Id（推荐）",
    required: false,
    secret: false,
    placeholder: "...",
    help: "~/.codex/auth.json 里的 account_id",
  },
  { key: "refreshToken", label: "Refresh Token（可选）", required: false, secret: true },
];

/** One descriptor per ChatGPT account; each slot stores its own credential and snapshot. */
function makeCodexDescriptor(provider: UsageProvider, label: string): ProviderDescriptor {
  const strategy = makeCodexOAuthStrategy(provider);
  return {
    provider,
    label,
    accentColor: "#19c37d",
    producesRateWindows: true,
    credentialFields: CREDENTIAL_FIELDS,
    resolveStrategies: () => [strategy],
    refresh,
  };
}

export const codexDescriptor = makeCodexDescriptor("codex", "Codex (ChatGPT 订阅)");
export const codex2Descriptor = makeCodexDescriptor("codex2", "Codex #2 (ChatGPT 订阅)");
