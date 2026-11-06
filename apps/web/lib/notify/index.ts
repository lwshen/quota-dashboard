import type { QuotaResetEvent, UsageFetchIssue, UsageProvider, UsageSnapshot } from "@quota/core";
import { detectQuotaResets } from "@quota/core";
import { ENV } from "../env";
import { getAlertState, getCredential, historyFor, listCredentials } from "../store";
import { FeishuChannel } from "./feishu";
import { buildQuotaResetMessage, buildStartupMessage, buildTestMessage } from "./message";
import type { NotifyChannel, NotifyDeliveryResult, NotifyMessage } from "./types";
import { NotifyError } from "./types";
import { processProviderAlerts, type AlertOptions, type AlertState } from "./alerts";

let _channels: NotifyChannel[] | null = null;

/** Channel registry — add new transports here (see types.ts). */
function channels(): NotifyChannel[] {
  if (!_channels) {
    const list: NotifyChannel[] = [];
    if (ENV.feishuWebhookUrl) {
      list.push(new FeishuChannel(ENV.feishuWebhookUrl, ENV.feishuWebhookSecret || undefined));
    }
    _channels = list;
  }
  return _channels;
}

export function notificationsEnabled(): boolean {
  return channels().length > 0;
}

// Resets are detected exactly once (the comparison base is overwritten right after),
// so a transient send failure would lose the notification forever — retry briefly.
const RETRY_DELAYS_MS = [1_000, 5_000];

async function sendWithRetry(ch: NotifyChannel, message: NotifyMessage, current = () => true): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    if (!current()) return false;
    try {
      await ch.send(message);
      return true;
    } catch (e) {
      if (!(e instanceof NotifyError && e.retryable) || attempt >= RETRY_DELAYS_MS.length) throw e;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

function alertOptions(provider: UsageProvider): AlertOptions {
  return {
    usageThresholds: ENV.notifyUsageThresholds,
    balanceThreshold: ENV.notifyBalanceThresholds[provider],
    failureThreshold: ENV.notifyFailureThreshold,
    cooldownSeconds: ENV.notifyCooldownSeconds,
    staleSeconds: Math.max(ENV.notifyStaleSeconds, 3 * Math.max(60, ENV.pollInterval)),
    recovery: ENV.notifyRecovery,
    dashboardUrl: ENV.dashboardUrl,
  };
}

export function detectAndNotifyAlerts(provider: UsageProvider, snapshot: UsageSnapshot | null, issue: UsageFetchIssue | undefined, now: Date): void {
  try {
    if (!ENV.notifyAlertsEnabled || !notificationsEnabled() || !getCredential(provider)?.enabled) return;
    const lastSuccessAt = snapshot ? undefined : historyFor(provider, 1)[0]?.fetchedAt;
    void processProviderAlerts(provider, { snapshot, issue, lastSuccessAt }, now, alertOptions(provider), channels(), sendWithRetry)
      .catch(() => console.error("[notify] alert processing failed"));
  } catch {
    console.error("[notify] alert processing failed");
  }
}

export function checkAndNotifyStaleUsage(now: Date): void {
  try {
    if (!ENV.notifyAlertsEnabled || !notificationsEnabled()) return;
    for (const credential of listCredentials().filter((item) => item.enabled)) {
      const health = getAlertState<AlertState>(credential.provider, "health");
      const lastSuccessAt = historyFor(credential.provider, 1)[0]?.fetchedAt;
      const since = lastSuccessAt ?? health?.firstFailureAt ?? credential.updatedAt;
      void processProviderAlerts(credential.provider, { staleSince: since, lastSuccessAt }, now,
        alertOptions(credential.provider), channels(), sendWithRetry)
        .catch(() => console.error("[notify] stale detection failed"));
    }
  } catch {
    console.error("[notify] stale detection failed");
  }
}

async function dispatch(message: NotifyMessage): Promise<NotifyDeliveryResult[]> {
  return Promise.all(
    channels().map(async (ch): Promise<NotifyDeliveryResult> => {
      try {
        await sendWithRetry(ch, message);
        return { channel: ch.name, ok: true, error: null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[notify] ${ch.name} send failed:`, msg);
        return { channel: ch.name, ok: false, error: msg };
      }
    }),
  );
}

// Belt-and-suspenders: suppress a duplicate send if the same lane's reset is somehow
// detected twice in quick succession (e.g. interleaved fetches persisting out of order).
const recentlyNotified = new Map<string, number>();
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

function withoutRecentDuplicates(events: QuotaResetEvent[], now: Date): QuotaResetEvent[] {
  const t = now.getTime();
  for (const [key, at] of recentlyNotified) {
    if (t - at > DEDUP_WINDOW_MS) recentlyNotified.delete(key);
  }
  return events.filter((e) => {
    const key = `${e.provider}:${e.laneId}`;
    if (recentlyNotified.has(key)) return false;
    recentlyNotified.set(key, t);
    return true;
  });
}

/**
 * Detect quota resets against the last good snapshot and notify all channels.
 * Must run BEFORE saveSnapshot persists `next`, which overwrites the comparison base.
 * Reads synchronously, sends fire-and-forget; never throws.
 */
export function detectAndNotifyResets(provider: UsageProvider, next: UsageSnapshot, now: Date): void {
  try {
    if (!notificationsEnabled()) return;
    const prev = historyFor(provider, 1)[0];
    if (!prev) return;
    // A stale base (fetch-error streak, host sleep, poller off) is not comparable:
    // rolling windows decay across the gap, which would read as a reset.
    const pollMs = Math.max(60, ENV.pollInterval) * 1000;
    const maxAgeMs = Math.max(3 * pollMs, 15 * 60 * 1000);
    if (now.getTime() - new Date(prev.fetchedAt).getTime() > maxAgeMs) return;
    const events = withoutRecentDuplicates(
      detectQuotaResets(prev.snapshot, next, { minUsedPercent: ENV.notifyMinUsedPercent }),
      now,
    );
    if (events.length === 0) return;
    void dispatch(buildQuotaResetMessage(events, now));
  } catch (e) {
    console.error("[notify] reset detection failed:", e);
  }
}

export async function sendTestNotification(now: Date): Promise<NotifyDeliveryResult[]> {
  return dispatch(buildTestMessage(now));
}

let startupNotified = false;

/** One-shot service-started message, called from instrumentation.ts; never throws. */
export async function sendStartupNotification(now: Date): Promise<void> {
  if (startupNotified || !notificationsEnabled()) return;
  startupNotified = true;
  try {
    await dispatch(
      buildStartupMessage(now, {
        pollIntervalSeconds: Math.max(60, ENV.pollInterval),
        pollerEnabled: ENV.enablePoller,
      }),
    );
  } catch (e) {
    console.error("[notify] startup notification failed:", e);
  }
}
