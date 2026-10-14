// Port of CodexBar's Grok OAuth billing path. Paste the `key` from ~/.grok/auth.json.
// Grok CLI refreshes its own tokens; xai-* management keys cannot read subscription usage.
import type { FetchContext, ProviderDescriptor, ProviderFetchStrategy } from "../adapter";
import { RateLimitedError, UnauthorizedError, UpstreamError } from "../adapter";
import type { HttpResponse } from "../http";
import { retryAfterSeconds } from "../decode";
import { grokSnapshot, parseGrokCredits } from "./grok-billing";
import type { GrokBilling } from "./grok-billing";
import { parseGrokGrpc, validateGrokGrpcStatus } from "./grok-grpc";

const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const WEB_BILLING_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const REAUTH = "Grok 凭据已失效，请运行 grok login 后更新 Access Token";

function checkResponse(res: HttpResponse): void {
  if (res.status === 401 || res.status === 403) throw new UnauthorizedError(REAUTH);
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
    if (c.expiresAt && Date.parse(c.expiresAt) <= ctx.now.getTime()) throw new UnauthorizedError(REAUTH);
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
  credentialFields: [{
    key: "bearerToken",
    label: "Grok Access Token",
    required: true,
    secret: true,
    placeholder: "eyJ...",
    help: "运行 grok login 后，复制 ~/.grok/auth.json 中对应账户的 key；过期后重新登录并更新。不是 xai- API Key。",
  }],
  resolveStrategies: (mode) => mode === "auto" || mode === "oauth" ? [grokOAuthStrategy] : [],
};
