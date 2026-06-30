// GET usage requires headers: Authorization: Bearer <access_token>, User-Agent: CodexBar, ChatGPT-Account-Id: <account_id>.
// Window role keyed by windowMinutes: 300=session(primary), 10080=weekly(secondary).

import type { FetchContext, ProviderCredentials, ProviderDescriptor, ProviderFetchStrategy, RefreshResult } from "../adapter";
import { RateLimitedError, UnauthorizedError, UpstreamError } from "../adapter";
import type { NamedRateWindow, ProviderCostSnapshot, RateWindow, UsageSnapshot } from "../model";
import { clampPercent, num, parseIsoOrUnix, retryAfterSeconds, safeJson } from "../decode";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const USER_AGENT = "CodexBar";

interface WindowParsed {
  window: RateWindow;
  minutes: number | null;
}

function windowFrom(node: unknown): WindowParsed | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  const used = num(obj.used_percent);
  if (used == null) return null;
  const seconds = num(obj.limit_window_seconds);
  const minutes = seconds != null ? Math.round(seconds / 60) : null;
  return {
    window: {
      usedPercent: clampPercent(used),
      windowMinutes: minutes,
      resetsAt: parseIsoOrUnix(obj.reset_at ?? obj.resets_at),
    },
    minutes,
  };
}

const codexOAuthStrategy: ProviderFetchStrategy = {
  id: "codex-oauth",
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
    if (res.status === 401 || res.status === 403) throw new UnauthorizedError();
    if (res.status === 429) throw new RateLimitedError(retryAfterSeconds(res.headers));
    if (res.status >= 400) throw new UpstreamError(res.status, res.body.slice(0, 200));
    const j = safeJson(res.body);
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

    const extra: NamedRateWindow[] = [];
    const additional = Array.isArray(j.additional_rate_limits) ? j.additional_rate_limits : [];
    for (const item of additional) {
      const w = windowFrom(item?.rate_limit?.primary_window) ?? windowFrom(item?.rate_limit?.secondary_window);
      if (w) {
        const name = String(item?.limit_name ?? item?.metered_feature ?? "extra");
        extra.push({ id: name, title: name, window: w.window, usageKnown: true });
      }
    }

    let cost: ProviderCostSnapshot | null = null;
    const credits = j.credits;
    if (credits && credits.has_credits && !credits.unlimited && credits.balance != null) {
      cost = { used: 0, limit: num(credits.balance) ?? 0, currencyCode: "USD", period: "Credits balance" };
    }

    const planType = typeof j.plan_type === "string" ? j.plan_type : null;
    const snapshot: UsageSnapshot = {
      provider: "codex",
      primary,
      secondary,
      tertiary: null,
      extraRateWindows: extra.length ? extra : null,
      providerCost: cost,
      identity: planType ? { providerID: "codex", loginMethod: `Plan: ${planType}` } : null,
      dataConfidence: primary || secondary ? "exact" : "unknown",
      updatedAt: ctx.now.toISOString(),
    };
    return snapshot;
  },
};

async function refresh(creds: ProviderCredentials, ctx: FetchContext): Promise<RefreshResult> {
  if (!creds.refreshToken) throw new UnauthorizedError("missing refresh_token");
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
    { timeoutMs: 30_000 },
  );
  const j = safeJson(res.body) ?? {};
  if (res.status >= 400) {
    const err = String(j.error ?? "");
    if (["refresh_token_expired", "refresh_token_reused", "invalid_grant", "refresh_token_invalidated"].includes(err)) {
      throw new UnauthorizedError(`${err}: re-login required`);
    }
    throw new UpstreamError(res.status, err || "refresh failed");
  }
  return {
    credentials: {
      ...creds,
      bearerToken: j.access_token ?? creds.bearerToken,
      refreshToken: j.refresh_token ?? creds.refreshToken,
      expiresAt: new Date(ctx.now.getTime() + 8 * 24 * 3600 * 1000).toISOString(), // time-based: 8 days
    },
  };
}

// ~/.codex/auth.json shape: { tokens: { access_token, refresh_token, account_id }, OPENAI_API_KEY }.
function parseCredentialFile(raw: unknown): ProviderCredentials | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const tokens = (root.tokens && typeof root.tokens === "object" ? root.tokens : root) as Record<string, unknown>;
  const access = typeof tokens.access_token === "string" ? tokens.access_token : null;
  if (!access) return null;
  const accountId =
    typeof tokens.account_id === "string"
      ? tokens.account_id
      : typeof root.account_id === "string"
        ? root.account_id
        : undefined;
  return {
    bearerToken: access,
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined,
    accountId,
  };
}

function serializeCredentialFile(creds: ProviderCredentials, prev: unknown): unknown {
  const root = (prev && typeof prev === "object" ? { ...(prev as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const tokens = { ...((root.tokens && typeof root.tokens === "object" ? root.tokens : {}) as Record<string, unknown>) };
  if (creds.bearerToken) tokens.access_token = creds.bearerToken;
  if (creds.refreshToken) tokens.refresh_token = creds.refreshToken;
  if (creds.accountId) tokens.account_id = creds.accountId;
  root.tokens = tokens;
  return root;
}

export const codexDescriptor: ProviderDescriptor = {
  provider: "codex",
  label: "Codex (ChatGPT 订阅)",
  producesRateWindows: true,
  credentialFields: [
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
  ],
  resolveStrategies: () => [codexOAuthStrategy],
  refresh,
  parseCredentialFile,
  serializeCredentialFile,
};
