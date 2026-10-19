// Port of CodexBar's Grok OAuth billing path. Paste the `key` from ~/.grok/auth.json.
// Refresh uses the official CLI's OIDC form grant; xai-* keys cannot read subscription usage.
import type { FetchContext, ProviderDescriptor, ProviderFetchStrategy } from "../adapter";
import { RateLimitedError, RefreshRejectedError, UnauthorizedError, UpstreamError } from "../adapter";
import type { HttpResponse } from "../http";
import { retryAfterSeconds, safeJson } from "../decode";
import { grokTokenExpiresAt } from "./grok-auth";
import { grokSnapshot, parseGrokCredits } from "./grok-billing";
import type { GrokBilling } from "./grok-billing";
import { parseGrokGrpc, validateGrokGrpcStatus } from "./grok-grpc";

const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const WEB_BILLING_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const REAUTH = "Grok 凭据已失效，请运行 grok login 后更新 Access Token";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";

function checkResponse(res: HttpResponse): void {
  if (res.status === 401) throw new UnauthorizedError(REAUTH);
  if (res.status === 403) throw new UpstreamError(403, "Grok 账单接口拒绝访问，请检查账户权限");
  if (res.status === 429) throw new RateLimitedError(retryAfterSeconds(res.headers));
  if (res.status !== 200) throw new UpstreamError(res.status, "Grok billing request failed");
}

async function webBilling(token: string, ctx: FetchContext, timeoutMs = 15_000): Promise<GrokBilling> {
  const res = await ctx.http.post(WEB_BILLING_URL, "\x00\x00\x00\x00\x02\x08\x00", {
    Authorization: `Bearer ${token}`,
    Origin: "https://grok.com",
    Referer: "https://grok.com/?_s=usage",
    Accept: "*/*",
    "Content-Type": "application/grpc-web+proto",
    "x-grpc-web": "1",
    "x-user-agent": "connect-es/2.1.1",
    "User-Agent": "quota-dashboard",
  }, { timeoutMs, retry: false });
  checkResponse(res);
  validateGrokGrpcStatus(res.headers);
  if (!res.bodyBytes) throw new UpstreamError(undefined, "Grok billing response is missing binary data");
  return parseGrokGrpc(res.bodyBytes, ctx.now);
}

const grokOAuthStrategy: ProviderFetchStrategy = {
  id: "grok-oauth",
  sourceMode: "oauth",
  isAvailable: (c) => !!c.bearerToken?.trim(),
  shouldFallback: () => false,
  async fetch(c, ctx) {
    const token = c.bearerToken!.trim().replace(/^Bearer(?:\s+|$)/i, "").trim();
    if (!token || /^(xai-|cookie:)/i.test(token) || /[=\s]/.test(token)) {
      throw new UnauthorizedError("请填写 grok login 生成的 Access Token（不是 xai- API Key 或 Cookie）");
    }
    const expiresAt = c.expiresAt || grokTokenExpiresAt(token);
    if (expiresAt && Date.parse(expiresAt) <= ctx.now.getTime()) throw new UnauthorizedError(REAUTH);
    let billing: GrokBilling;
    try {
      const res = await ctx.http.get(CREDITS_URL, {
        Authorization: `Bearer ${token}`,
        "x-xai-token-auth": "xai-grok-cli",
        Accept: "application/json",
        "User-Agent": "quota-dashboard",
      }, { timeoutMs: 15_000 });
      checkResponse(res);
      billing = parseGrokCredits(res.body, ctx.now);
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      try {
        return grokSnapshot(await webBilling(token, ctx), ctx.now);
      } catch (fallbackError) {
        // Preserve a clear expired-token error when the web surface also rejects billing.
        if (error instanceof UnauthorizedError) throw error;
        throw fallbackError;
      }
    }
    if (billing.usedPercent == null) {
      try {
        const enriched = await webBilling(token, ctx, 6_000);
        billing = {
          ...enriched,
          resetsAt: billing.resetsAt ?? enriched.resetsAt,
          windowMinutes: billing.resetsAt == null ? enriched.windowMinutes : billing.windowMinutes,
          subscriptionTier: billing.subscriptionTier,
          balance: billing.balance,
        };
      } catch {
        // A failed optional lookup must preserve valid period/plan/wallet metadata.
      }
    }
    return grokSnapshot(billing, ctx.now);
  },
};

export const grokDescriptor: ProviderDescriptor = {
  provider: "grok",
  label: "Grok (SuperGrok 订阅)",
  accentColor: "#a3a3a3",
  producesRateWindows: true,
  refreshLeadTimeMs: 10 * 60_000,
  async refresh(creds, ctx) {
    if (!creds.refreshToken || !creds.extra?.clientId) {
      throw new RefreshRejectedError("Grok 自动续期缺少 Refresh Token 或 Client ID，请重新导入凭据");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token", refresh_token: creds.refreshToken, client_id: creds.extra.clientId,
    });
    if (creds.extra.principalType) body.set("principal_type", creds.extra.principalType);
    if (creds.extra.principalId) body.set("principal_id", creds.extra.principalId);
    let res: HttpResponse;
    try {
      res = await ctx.http.post(TOKEN_URL, body.toString(), {
        "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json",
      }, { timeoutMs: 15_000, retry: false });
    } catch {
      throw new UpstreamError(undefined, "Grok 续期网络请求失败，请稍后重试");
    }
    const json = safeJson(res.body);
    if (res.status === 429) throw new RateLimitedError(retryAfterSeconds(res.headers), "Grok 续期请求受到限流");
    if (res.status >= 400) {
      if (["invalid_grant", "invalid_client"].includes(json?.error)) {
        throw new RefreshRejectedError("Grok 刷新凭据已失效，请重新登录并导入凭据");
      }
      throw new UpstreamError(res.status, "Grok 续期失败，请稍后重试");
    }
    const accessToken = typeof json?.access_token === "string" ? json.access_token.trim() : "";
    if (!accessToken || /\s/.test(accessToken)) throw new UpstreamError(undefined, "Grok 续期响应缺少有效的 Access Token");
    const seconds = ["number", "string"].includes(typeof json?.expires_in) ? Number(json.expires_in) : NaN;
    const expiresAt = Number.isFinite(seconds) && seconds > 0 && seconds < 365 * 86400
      ? new Date(ctx.now.getTime() + seconds * 1000).toISOString() : grokTokenExpiresAt(accessToken);
    const refreshToken = typeof json?.refresh_token === "string" && json.refresh_token.trim() ? json.refresh_token.trim() : creds.refreshToken;
    return { credentials: { ...creds, bearerToken: accessToken, refreshToken, expiresAt, refreshState: undefined } };
  },
  credentialFields: [{
    key: "bearerToken",
    label: "Grok Access Token",
    required: true,
    secret: true,
    placeholder: "eyJ...",
    help: "可导入 auth.json，或填写其中的 key。不是 xai- API Key。",
  }, {
    key: "refreshToken", label: "Refresh Token（可选，用于自动续期）", required: false, secret: true,
    help: "对应 refresh_token；使用由看板管理的登录凭据，避免与 CLI 同时续期同一份凭据。",
  }, {
    key: "extra.clientId", label: "Client ID（自动续期时必填）", required: false, secret: false,
    help: "对应 oidc_client_id，从凭据文件导入时自动填写。",
  }, {
    key: "expiresAt", label: "过期时间（可选）", required: false, secret: false,
    placeholder: "2026-10-20T00:00:00Z", help: "对应 expires_at；留空时从 JWT 自动读取。",
  }],
  resolveStrategies: (mode) => mode === "auto" || mode === "oauth" ? [grokOAuthStrategy] : [],
};
