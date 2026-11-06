// A malformed value silently becoming NaN would disable downstream range checks.
function numOr(raw: string | undefined, name: string, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[env] ${name}="${raw}" is not a number; using ${fallback}`);
    return fallback;
  }
  return n;
}

function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(numOr(process.env[name], name, fallback))));
}

function usageThresholds(): number[] {
  const raw = process.env.NOTIFY_USAGE_THRESHOLDS;
  if (raw == null) return [80, 95];
  if (!raw.trim()) return [];
  const values = raw.split(",").map((part) => part.trim() ? Number(part) : NaN);
  if (values.some((value) => !Number.isFinite(value) || value <= 0 || value > 100)) {
    console.warn("[env] Invalid NOTIFY_USAGE_THRESHOLDS; using 80,95");
    return [80, 95];
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

function balanceThresholds(): Partial<Record<string, number>> {
  const raw = process.env.NOTIFY_BALANCE_THRESHOLDS;
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    const providers = ["claude", "codex", "codex2", "grok", "kimi", "moonshot", "rightapi"];
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.entries(parsed).some(([key, value]) => !providers.includes(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error();
    return parsed as Record<string, number>;
  } catch {
    console.warn("[env] Invalid NOTIFY_BALANCE_THRESHOLDS; balance alerts disabled");
    return {};
  }
}

export const ENV = {
  encKey: process.env.APP_ENC_KEY ?? "",
  dbPath: process.env.DATABASE_PATH ?? "./data/quota.sqlite",
  // Default 5min / floor 1min (poller.ts enforces the floor); usage endpoints rate-limit faster polling.
  pollInterval: numOr(process.env.POLL_INTERVAL_SECONDS, "POLL_INTERVAL_SECONDS", 300),
  enablePoller: (process.env.ENABLE_POLLER ?? "true") !== "false",
  // If unset, middleware blocks all requests (fail-closed).
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? "",
  // Falls back to APP_ENC_KEY when unset.
  authSecret: process.env.AUTH_SECRET ?? "",
  // SECURITY: do not enable in production.
  authDisabled: (process.env.AUTH_DISABLED ?? "false") === "true",
  // Logs raw quota API responses to the server console; never exposes them to clients.
  debug: (process.env.DEBUG ?? "false") === "true",
  // Feishu (Lark) custom-bot webhook for quota-reset notifications; unset disables them.
  feishuWebhookUrl: process.env.FEISHU_WEBHOOK_URL ?? "",
  // Optional signature-verification secret configured on the Feishu bot.
  feishuWebhookSecret: process.env.FEISHU_WEBHOOK_SECRET ?? "",
  // Only notify when a window had reached this used% before resetting; 0 notifies on every reset.
  notifyMinUsedPercent: numOr(process.env.NOTIFY_MIN_USED_PERCENT, "NOTIFY_MIN_USED_PERCENT", 80),
  notifyAlertsEnabled: (process.env.NOTIFY_ALERTS_ENABLED ?? "true") !== "false",
  notifyUsageThresholds: usageThresholds(),
  notifyBalanceThresholds: balanceThresholds(),
  notifyFailureThreshold: boundedNumber("NOTIFY_FAILURE_THRESHOLD", 3, 1, 100),
  notifyCooldownSeconds: boundedNumber("NOTIFY_COOLDOWN_SECONDS", 21600, 60, 30 * 86400),
  notifyStaleSeconds: boundedNumber("NOTIFY_STALE_SECONDS", 1800, 60, 30 * 86400),
  notifyRecovery: (process.env.NOTIFY_RECOVERY ?? "true") !== "false",
  // Used only in notification links; never as a request destination.
  dashboardUrl: process.env.DASHBOARD_URL ?? "",
};
