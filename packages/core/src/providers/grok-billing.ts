// Normalizes CLI proxy credits and web billing snapshots.
import { UpstreamError } from "../adapter";
import { clampPercent, parseIsoOrUnix, safeJson } from "../decode";
import type { UsageSnapshot } from "../model";

export interface GrokBilling {
  usedPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  subscriptionTier: string | null;
  products: NonNullable<UsageSnapshot["usageBreakdown"]>;
  balance: number | null;
  sourceKey: "credits" | "on-demand";
}

export function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function periodMinutes(start: unknown, end: string | null, now: Date): number | null {
  const startISO = parseIsoOrUnix(start);
  if (!startISO || !end) return null;
  const startMs = Date.parse(startISO);
  const minutes = Math.floor((Date.parse(end) - startMs) / 60_000);
  return startMs <= now.getTime() && minutes > 0 ? minutes : null;
}

function planName(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const compact = trimmed.toLowerCase().replace(/[^a-z]/g, "");
  if (compact === "supergrokheavy" || compact === "heavy") return "SuperGrok Heavy";
  return compact === "supergrok" ? "SuperGrok" : trimmed;
}

function prepaidBalance(value: unknown): number | null {
  const wallet = object(value);
  if (!wallet) return null;
  if (Object.keys(wallet).length === 0) return 0;
  const raw = wallet.val;
  if (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw))) return null;
  const cents = Number(raw);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents / 100 : null;
}

const PRODUCT_NAMES = new Map([
  ["GrokBuild", "Grok Build"],
  ["GrokChat", "Grok Chat"],
  ["GrokImagine", "Grok Imagine"],
  ["GrokAppBuilder", "Grok App Builder"],
]);

export function productShares(value: unknown, total: number | null): GrokBilling["products"] {
  if (total == null || !Array.isArray(value) || value.length === 0) return [];
  const seen = new Set<string>();
  const products: GrokBilling["products"] = [];
  for (const item of value) {
    const entry = object(item);
    const product = typeof entry?.product === "string" ? entry.product.trim() : "";
    const percent = finite(entry?.usagePercent);
    if (!product || percent == null || percent < 0 || seen.has(product)) return [];
    seen.add(product);
    products.push({ id: product, title: PRODUCT_NAMES.get(product) ?? product, usedPercent: percent });
  }
  const sum = products.reduce((n, p) => n + p.usedPercent, 0);
  if (!Number.isFinite(sum) || Math.abs(sum - total) > 1) return [];
  return products.filter((p) => p.usedPercent > 0).sort((a, b) => b.usedPercent - a.usedPercent);
}

export function parseGrokCredits(body: string, now: Date): GrokBilling {
  const response = object(safeJson(body));
  const config = object(response?.config);
  if (!config) throw new UpstreamError(undefined, "无法解析 Grok 账单数据");
  const period = object(config.currentPeriod);
  const currentEnd = parseIsoOrUnix(period?.end);
  const resetsAt = currentEnd ?? parseIsoOrUnix(config.billingPeriodEnd);
  // Never combine the start of a monthly billing cycle with the end of a weekly quota.
  const start = currentEnd ? period?.start : config.billingPeriodStart;
  const reported = finite(config.creditUsagePercent);
  const cap = finite(object(config.onDemandCap)?.val);
  const used = finite(object(config.onDemandUsed)?.val);
  const ratio = cap != null && cap > 0 && used != null ? used / cap * 100 : null;
  const percent = reported ?? finite(ratio);
  const balance = prepaidBalance(config.prepaidBalance);
  if (percent == null && resetsAt == null && balance == null) {
    throw new UpstreamError(undefined, "Grok 账单未返回用量、周期或余额");
  }
  return {
    usedPercent: percent == null ? null : clampPercent(percent),
    resetsAt,
    windowMinutes: periodMinutes(start, resetsAt, now),
    subscriptionTier: planName(config.subscriptionTier ?? response?.subscriptionTier),
    products: productShares(config.productUsage, reported),
    balance,
    sourceKey: reported == null && percent != null ? "on-demand" : "credits",
  };
}

export function grokSnapshot(billing: GrokBilling, now: Date): UsageSnapshot {
  const known = billing.usedPercent != null;
  return {
    provider: "grok",
    primary: known || billing.resetsAt ? {
      usedPercent: billing.usedPercent ?? 0,
      usageKnown: known,
      windowMinutes: billing.windowMinutes,
      resetsAt: billing.resetsAt,
      sourceKey: billing.sourceKey,
    } : null,
    secondary: null,
    tertiary: null,
    usageBreakdown: billing.products.length ? billing.products : null,
    providerCost: billing.balance == null ? null : {
      used: 0, limit: 0, balance: billing.balance, currencyCode: "USD", period: "预付余额",
    },
    identity: billing.subscriptionTier ? { providerID: "grok", loginMethod: `Plan: ${billing.subscriptionTier}` } : null,
    dataConfidence: known ? "exact" : "unknown",
    updatedAt: now.toISOString(),
  };
}
