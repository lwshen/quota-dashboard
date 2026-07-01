// GET https://api.moonshot.{ai|cn}/v1/users/me/balance — CN vs global host.
// Success requires body code==0 && status==true (not just HTTP 200).

import type { ProviderDescriptor, ProviderFetchStrategy } from "../adapter";
import { RateLimitedError, UnauthorizedError, UpstreamError } from "../adapter";
import type { UsageSnapshot } from "../model";
import { num, safeJson } from "../decode";

function host(region?: string): string {
  return region?.trim().toLowerCase() === "cn" ? "https://api.moonshot.cn" : "https://api.moonshot.ai";
}

const moonshotStrategy: ProviderFetchStrategy = {
  id: "moonshot-balance",
  sourceMode: "api",
  isAvailable: (c) => !!c.bearerToken,
  shouldFallback: () => false,
  async fetch(c, ctx) {
    const res = await ctx.http.get(
      `${host(c.region)}/v1/users/me/balance`,
      { Authorization: `Bearer ${c.bearerToken}`, Accept: "application/json" },
      { timeoutMs: 15_000 },
    );
    if (res.status === 401 || res.status === 403) throw new UnauthorizedError();
    if (res.status === 429) throw new RateLimitedError();
    if (res.status >= 400) throw new UpstreamError(res.status, res.body.slice(0, 200));
    const j = safeJson(res.body);
    if (!j || j.code !== 0 || j.status !== true) {
      throw new UpstreamError(res.status, `moonshot error code=${j?.code} status=${j?.status}`);
    }
    const data = (j.data ?? {}) as Record<string, unknown>;
    const available = num(data.available_balance) ?? 0;
    const cash = num(data.cash_balance) ?? 0;
    let login = `Balance: $${available.toFixed(2)}`;
    if (cash < 0) login += ` · $${Math.abs(cash).toFixed(2)} in deficit`;

    const snapshot: UsageSnapshot = {
      provider: "moonshot",
      primary: null,
      secondary: null,
      tertiary: null,
      identity: { providerID: "moonshot", loginMethod: login },
      dataConfidence: "exact",
      updatedAt: ctx.now.toISOString(),
      extra: { balance: data },
    };
    return snapshot;
  },
};

export const moonshotDescriptor: ProviderDescriptor = {
  provider: "moonshot",
  label: "Moonshot (Balance)",
  accentColor: "#22b8cf",
  producesRateWindows: false,
  credentialFields: [
    {
      key: "bearerToken",
      label: "Moonshot API Key",
      required: true,
      secret: true,
      placeholder: "sk-...",
      help: "MOONSHOT_API_KEY",
    },
    { key: "region", label: "Region（ai / cn）", required: false, secret: false, placeholder: "ai" },
  ],
  resolveStrategies: () => [moonshotStrategy],
};
