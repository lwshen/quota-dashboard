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
};
