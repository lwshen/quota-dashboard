// GET {base}/coding/v1/usages, Authorization: Bearer <key>.
// usage -> weekly (primary); limits[0].detail -> 5h rate (secondary, windowMinutes=300 hardcoded client-side).

import type { ProviderDescriptor, ProviderFetchStrategy } from "../adapter";
import { RateLimitedError, UnauthorizedError, UpstreamError } from "../adapter";
import type { RateWindow, UsageSnapshot } from "../model";
import { clampPercent, num, parseIsoOrUnix, pick, retryAfterSeconds, safeJson } from "../decode";
import { assertSafeExternalUrl } from "../net";

interface Computed {
  usedPercent: number | null;
  used?: number;
  limit?: number;
  resetsAt: string | null;
}

function compute(detail: unknown): Computed | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  const limit = num(d.limit);
  let used = num(d.used);
  const remaining = num(d.remaining);
  if (used == null && limit != null && remaining != null) used = limit - remaining;
  const resetsAt = parseIsoOrUnix(pick(d, ["resetTime", "resetAt", "reset_time", "reset_at"]));
  if (limit == null || used == null || limit <= 0) {
    return { usedPercent: null, used, limit, resetsAt };
  }
  return { usedPercent: clampPercent((used / limit) * 100), used, limit, resetsAt };
}

/** Base may already include coding / coding/v1; avoid duplicating the path segment. */
function buildUrl(override?: string): string {
  const trimmed = override?.trim();
  if (!trimmed) return "https://api.kimi.com/coding/v1/usages";
  assertSafeExternalUrl(trimmed); // SSRF: reject non-https / private-network hosts
  const base = trimmed.replace(/\/+$/, "");
  if (/coding\/v1$/.test(base)) return `${base}/usages`;
  if (/coding$/.test(base)) return `${base}/v1/usages`;
  return `${base}/coding/v1/usages`;
}

const kimiCodeApiStrategy: ProviderFetchStrategy = {
  id: "kimi-code-api",
  sourceMode: "api",
  isAvailable: (c) => !!c.bearerToken,
  shouldFallback: () => false,
  async fetch(c, ctx) {
    const res = await ctx.http.get(
      buildUrl(c.baseUrlOverride),
      { Authorization: `Bearer ${c.bearerToken}`, Accept: "application/json" },
      { timeoutMs: 20_000 },
    );
    if (res.status === 401 || res.status === 403) throw new UnauthorizedError();
    if (res.status === 429) throw new RateLimitedError(retryAfterSeconds(res.headers));
    if (res.status >= 400) throw new UpstreamError(res.status, res.body.slice(0, 200));
    const j = safeJson(res.body);
    if (!j) throw new UpstreamError(res.status, "invalid JSON");

    const weekly = compute(j.usage);
    const limits = Array.isArray(j.limits) ? j.limits : [];
    const rate = compute(limits[0]?.detail);

    const primary: RateWindow | null = weekly
      ? {
          usedPercent: weekly.usedPercent ?? 0,
          windowMinutes: null,
          resetsAt: weekly.resetsAt,
          resetDescription:
            weekly.used != null && weekly.limit != null ? `${weekly.used}/${weekly.limit} requests` : null,
        }
      : null;
    const secondary: RateWindow | null = rate
      ? {
          usedPercent: rate.usedPercent ?? 0,
          windowMinutes: 300,
          resetsAt: rate.resetsAt,
          resetDescription:
            rate.used != null && rate.limit != null ? `Rate: ${rate.used}/${rate.limit} per 5h` : null,
        }
      : null;

    const snapshot: UsageSnapshot = {
      provider: "kimi",
      primary,
      secondary,
      tertiary: null,
      dataConfidence: weekly?.usedPercent != null ? "exact" : weekly ? "percentOnly" : "unknown",
      updatedAt: ctx.now.toISOString(),
    };
    return snapshot;
  },
};

export const kimiDescriptor: ProviderDescriptor = {
  provider: "kimi",
  label: "Kimi (Code API)",
  producesRateWindows: true,
  credentialFields: [
    {
      key: "bearerToken",
      label: "Kimi Code API Key",
      required: true,
      secret: true,
      placeholder: "sk-...",
      help: "KIMI_CODE_API_KEY / Kimi 开发者控制台",
    },
    {
      key: "baseUrlOverride",
      label: "Base URL（可选）",
      required: false,
      secret: false,
      placeholder: "https://api.kimi.com",
    },
  ],
  resolveStrategies: () => [kimiCodeApiStrategy],
};
