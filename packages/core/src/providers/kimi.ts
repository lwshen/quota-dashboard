// GET {base}/coding/v1/usages, Authorization: Bearer <key>.
// Ratio pools and legacy counters share weekly (primary) and session (secondary) lanes.

import type { ProviderDescriptor, ProviderFetchStrategy } from "../adapter";
import { RateLimitedError, UnauthorizedError, UpstreamError } from "../adapter";
import type { RateWindow, UsageSnapshot } from "../model";
import { asRecord, num, parseIsoOrUnix, pick, retryAfterSeconds, safeJson } from "../decode";
import { assertSafeExternalUrl } from "../net";

interface Computed {
  usedPercent: number | null;
  used?: number;
  limit?: number;
  resetsAt: string | null;
}

function compute(detail: unknown): Computed | null {
  const d = asRecord(detail);
  if (!d) return null;
  const limit = num(d.limit);
  let used = num(d.used);
  const remaining = num(d.remaining);
  if (used == null || used < 0) {
    used = limit != null && remaining != null && remaining >= 0 && remaining <= limit ? limit - remaining : undefined;
  }
  const resetsAt = parseIsoOrUnix(pick(d, ["resetTime", "resetAt", "reset_time", "reset_at"]));
  if (limit == null || used == null || limit <= 0) {
    return { usedPercent: null, used, limit, resetsAt };
  }
  return { usedPercent: Math.min(1, used / limit) * 100, used, limit, resetsAt };
}

function durationMinutes(value: unknown): number | null {
  if (value == null) return 300;
  const window = asRecord(value);
  const duration = num(window?.duration);
  const unit = window?.timeUnit;
  const multiplier = unit === "TIME_UNIT_MINUTE" ? 1 : unit === "TIME_UNIT_HOUR" ? 60 : unit === "TIME_UNIT_DAY" ? 1440 : null;
  const minutes = duration != null && multiplier != null ? duration * multiplier : NaN;
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : null;
}

function quotaWindow(pool: unknown, counts: Computed | null, minutes: number | null, countMinutes: number | null): RateWindow | null {
  const ratio = asRecord(pool);
  const usedRatio = num(ratio?.used_ratio);
  const ratioWindow: RateWindow | null = usedRatio != null && usedRatio >= 0 ? {
    usedPercent: Math.min(1, usedRatio) * 100, usageKnown: true, windowMinutes: minutes,
    resetsAt: parseIsoOrUnix(ratio?.reset_time),
  } : null;
  // Counts may contradict a ratio only when both describe the same duration and reset.
  const contradictoryCounts = ratioWindow != null && counts?.usedPercent != null
    && counts.usedPercent > ratioWindow.usedPercent && countMinutes === minutes
    && counts.resetsAt != null && ratioWindow.resetsAt != null
    && Math.abs(Date.parse(counts.resetsAt) - Date.parse(ratioWindow.resetsAt)) <= 2000;
  if (ratioWindow && !contradictoryCounts) return ratioWindow;
  if (!counts) return null;
  const known = counts.usedPercent != null;
  const duration = known ? countMinutes : null;
  const description = known && counts.used != null && counts.limit != null
    ? `${counts.used}/${counts.limit} requests${duration != null && duration !== 10080 ? ` per ${duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`}` : ""}` : null;
  return {
    usedPercent: counts.usedPercent ?? 0, usageKnown: known, windowMinutes: duration,
    resetsAt: counts.resetsAt, resetDescription: description,
  };
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
    if (!asRecord(j)) throw new UpstreamError(res.status, "invalid JSON");

    const weekly = compute(j.usage);
    const limits = Array.isArray(j.limits) ? j.limits : [];
    const rateLimit = asRecord(limits[0]);
    const rate = compute(rateLimit?.detail);
    const pools = asRecord(j.usages);
    const primary = quotaWindow(pools?.limit_7d, weekly, 10080, 10080);
    const secondary = quotaWindow(pools?.limit_5h, rate, 300, durationMinutes(rateLimit?.window));
    // The API supplies no calendar-month start; do not invent a fixed duration for pacing.
    const monthly = quotaWindow(pools?.limit_month_total, null, null, null);
    if (!primary && !secondary && !monthly) throw new UpstreamError(undefined, "no supported quota windows in Kimi response");
    const known = [primary, secondary, monthly].some((window) => window && window.usageKnown !== false);

    const snapshot: UsageSnapshot = {
      provider: "kimi",
      primary,
      secondary,
      tertiary: null,
      extraRateWindows: monthly ? [{ id: "kimi-monthly", title: "月总用量", window: monthly, usageKnown: true }] : null,
      dataConfidence: known ? "exact" : "unknown",
      updatedAt: ctx.now.toISOString(),
    };
    return snapshot;
  },
};

export const kimiDescriptor: ProviderDescriptor = {
  provider: "kimi",
  label: "Kimi (Code API)",
  accentColor: "#8b7cff",
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
