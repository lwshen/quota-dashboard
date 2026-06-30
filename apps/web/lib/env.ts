export const ENV = {
  encKey: process.env.APP_ENC_KEY ?? "",
  dbPath: process.env.DATABASE_PATH ?? "./data/quota.sqlite",
  // Default 5min / floor 1min (poller.ts enforces the floor); usage endpoints rate-limit faster polling.
  pollInterval: Number(process.env.POLL_INTERVAL_SECONDS ?? "300"),
  enablePoller: (process.env.ENABLE_POLLER ?? "true") !== "false",
  // If unset, middleware blocks all requests (fail-closed).
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? "",
  // Falls back to APP_ENC_KEY when unset.
  authSecret: process.env.AUTH_SECRET ?? "",
  // SECURITY: do not enable in production.
  authDisabled: (process.env.AUTH_DISABLED ?? "false") === "true",
};
