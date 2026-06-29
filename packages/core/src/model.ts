export type UsageProvider = "claude" | "codex" | "kimi" | "moonshot";

export type UsageDataConfidence = "exact" | "estimated" | "percentOnly" | "unknown";

export interface RateWindow {
  /** Percent used, not remaining. */
  usedPercent: number;
  /** Window length in minutes. 5h=300, 7d=10080. */
  windowMinutes?: number | null;
  resetsAt?: string | null;
  resetDescription?: string | null;
  nextRegenPercent?: number | null;
}

export function remainingPercent(w: RateWindow): number {
  return Math.max(0, 100 - w.usedPercent);
}

export interface NamedRateWindow {
  id: string;
  title: string;
  window: RateWindow;
  /** false = show only reset metadata; do not treat usedPercent as real consumption. */
  usageKnown: boolean;
}

export interface ProviderCostSnapshot {
  used: number;
  /** 0 means unlimited/unknown. */
  limit: number;
  currencyCode: string;
  period?: string | null;
  resetsAt?: string | null;
}

export interface ProviderIdentitySnapshot {
  providerID?: UsageProvider | null;
  accountEmail?: string | null;
  accountOrganization?: string | null;
  /** Also reused to stash plain text like "Credits: 1234" / "Balance: $5.00". */
  loginMethod?: string | null;
}

export interface UsageSnapshot {
  provider: UsageProvider;
  /** Always serialized even when null to keep the schema stable. */
  primary: RateWindow | null;
  secondary: RateWindow | null;
  tertiary: RateWindow | null;
  extraRateWindows?: NamedRateWindow[] | null;
  providerCost?: ProviderCostSnapshot | null;
  identity?: ProviderIdentitySnapshot | null;
  dataConfidence: UsageDataConfidence;
  updatedAt: string;
  subscriptionExpiresAt?: string | null;
  subscriptionRenewsAt?: string | null;
  extra?: Record<string, unknown>;
}

export function emptySnapshot(provider: UsageProvider, now: Date): UsageSnapshot {
  return {
    provider,
    primary: null,
    secondary: null,
    tertiary: null,
    dataConfidence: "unknown",
    updatedAt: now.toISOString(),
  };
}

export function hasRateWindows(s: UsageSnapshot): boolean {
  return !!(s.primary || s.secondary || s.tertiary || (s.extraRateWindows && s.extraRateWindows.length));
}
