import { ENV } from "./env";
import { fetchAllConfigured } from "./fetcher";

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function startPoller(): void {
  if (started || !ENV.enablePoller) return;
  started = true;
  const ms = Math.max(15, ENV.pollInterval) * 1000;

  fetchAllConfigured().catch((e) => console.error("[poller] initial fetch failed", e));

  timer = setInterval(() => {
    fetchAllConfigured().catch((e) => console.error("[poller] fetch failed", e));
  }, ms);
  if (typeof timer.unref === "function") timer.unref();

  console.log(`[poller] started, every ${ms / 1000}s`);
}
