import { randomUUID } from "node:crypto";
import type { RateWindow, UsageFetchIssue, UsageProvider, UsageSnapshot } from "@quota/core";
import { laneMeta } from "../format";
import { getAlertState, saveAlertState } from "../store";
import { buildAlertMessage } from "./message";
import type { NotifyChannel, NotifyMessage } from "./types";

export interface AlertOptions {
  usageThresholds: number[];
  balanceThreshold?: number;
  failureThreshold: number;
  cooldownSeconds: number;
  staleSeconds: number;
  recovery: boolean;
  dashboardUrl?: string;
  accountId?: string;
  accountLabel?: string;
}

export type AlertNotice =
  | { kind: "quota"; title: string; value: number; threshold: number; resetsAt?: string | null }
  | { kind: "balance"; value: number; threshold: number; unit: string }
  | { kind: "credentials"; refreshRejected: boolean; lastSuccessAt?: string }
  | { kind: "failure"; failures: number; rateLimited: boolean; lastSuccessAt?: string }
  | { kind: "stale"; since: string }
  | { kind: "recovery" };

interface DeliveryState {
  sentAt?: number;
  sentLevel?: number;
  notice?: "problem" | "recovery";
  lease?: { token: string; until: number };
}

export interface AlertState {
  level: number;
  failures?: number;
  firstFailureAt?: string;
  lastSuccessAt?: string;
  issueKind?: UsageFetchIssue["kind"] | "stale";
  channels: Record<string, DeliveryState>;
}

interface Metric { key: string; level: number; notice: AlertNotice }
interface Receipt { key: string; token: string; level: number; recovery: boolean }

export function resetHealthAlertState(provider: string): void {
  const state = getAlertState<AlertState>(provider, "health");
  if (!state) return;
  state.level = 0;
  state.failures = 0;
  state.firstFailureAt = undefined;
  state.issueKind = undefined;
  for (const delivery of Object.values(state.channels)) {
    delivery.lease = undefined;
    delivery.sentAt = undefined;
    delivery.sentLevel = undefined;
  }
  saveAlertState(provider, "health", state);
}

function quotaMetrics(snapshot: UsageSnapshot, thresholds: number[]): Metric[] {
  const result: Metric[] = [];
  const add = (id: string, title: string, window: RateWindow, known?: boolean) => {
    const trustworthy = known ?? window.usageKnown ?? (snapshot.dataConfidence === "exact" || snapshot.dataConfidence === "estimated");
    if (!trustworthy || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) return;
    const threshold = thresholds.filter((value) => window.usedPercent >= value).at(-1) ?? 0;
    result.push({
      key: JSON.stringify(["quota", id, window.sourceKey ?? null, window.windowMinutes ?? null]), level: threshold,
      notice: { kind: "quota", title, value: window.usedPercent, threshold, resetsAt: window.resetsAt },
    });
  };
  for (const lane of ["primary", "secondary", "tertiary"] as const) {
    const window = snapshot[lane];
    if (!window) continue;
    const title = window.sourceKey === "seven_day_sonnet" ? "Sonnet (7d)" : window.sourceKey === "seven_day_opus" ? "Opus (7d)"
      : laneMeta(snapshot.provider, lane, window.windowMinutes).title;
    add(lane, title, window);
  }
  for (const extra of snapshot.extraRateWindows ?? []) {
    add(`extra:${extra.id}:${extra.title}`, extra.title, extra.window, extra.usageKnown && extra.window.usageKnown !== false);
  }
  const cost = snapshot.providerCost;
  if (cost && Number.isFinite(cost.limit) && cost.limit > 0 && Number.isFinite(cost.used) && cost.used >= 0 && !/balance/i.test(cost.period ?? "")) {
    const value = cost.used / cost.limit * 100;
    if (Number.isFinite(value)) {
      const threshold = thresholds.filter((limit) => value >= limit).at(-1) ?? 0;
      result.push({ key: JSON.stringify(["cost", cost.currencyCode, cost.period ?? null]), level: threshold,
        notice: { kind: "quota", title: cost.period ? `${cost.period} · 周期已用` : "周期已用", value, threshold, resetsAt: cost.resetsAt } });
    }
  }
  return result;
}

function balanceMetric(snapshot: UsageSnapshot, threshold: number | undefined): Metric | null {
  if (threshold == null || !Number.isFinite(threshold) || threshold < 0) return null;
  const cost = snapshot.providerCost;
  let value = cost?.balance ?? (cost?.used === 0 && /balance/i.test(cost.period ?? "") ? cost.limit : null);
  let unit = cost?.currencyCode ?? "";
  if (value == null && (snapshot.provider === "moonshot" || snapshot.provider === "rightapi")) {
    const match = /^Balance:\s*(.*?)\s*([+-]?\d+(?:\.\d+)?)\s*(?:·|$)/.exec(snapshot.identity?.loginMethod ?? "");
    if (match) { value = Number(match[2]); unit = match[1]!.trim(); }
  }
  if (value == null || !Number.isFinite(value)) return null;
  return { key: JSON.stringify(["balance", unit]), level: value <= threshold ? 1 : 0,
    notice: { kind: "balance", value, threshold, unit } };
}

type Send = (channel: NotifyChannel, message: NotifyMessage, current: () => boolean) => Promise<boolean>;

// SQLite reservations are shared by route handlers and instrumentation, unlike module-level maps.
export async function processProviderAlerts(
  provider: UsageProvider, observation: { snapshot?: UsageSnapshot | null; issue?: UsageFetchIssue; staleSince?: string; lastSuccessAt?: string },
  now: Date, options: AlertOptions, channels: NotifyChannel[], send: Send,
): Promise<void> {
  const time = now.getTime();
  const accountId = options.accountId ?? provider;
  const plans = new Map<string, { channel: NotifyChannel; notices: AlertNotice[]; receipts: Receipt[] }>();
  const schedule = (key: string, state: AlertState, notice: AlertNotice, recovery = false) => {
    for (const channel of channels) {
      const delivery = state.channels[channel.name] ?? {};
      if (delivery.lease && delivery.lease.until > time) continue;
      const due = recovery ? delivery.notice === "problem"
        : state.level > 0 && (delivery.sentAt == null || state.level > (delivery.sentLevel ?? 0)
          || time - delivery.sentAt >= options.cooldownSeconds * 1000);
      if (!due) continue;
      const token = randomUUID();
      state.channels[channel.name] = { ...delivery, lease: { token, until: time + 60_000 } };
      const plan = plans.get(channel.name) ?? { channel, notices: [], receipts: [] };
      plan.notices.push(notice);
      plan.receipts.push({ key, token, level: state.level, recovery });
      plans.set(channel.name, plan);
    }
    saveAlertState(accountId, key, state);
  };

  const health = getAlertState<AlertState>(accountId, "health") ?? { level: 0, failures: 0, channels: {} };
  if (observation.lastSuccessAt && !health.lastSuccessAt) health.lastSuccessAt = observation.lastSuccessAt;
  if (observation.snapshot) {
    health.level = 0;
    health.failures = 0;
    health.firstFailureAt = undefined;
    health.issueKind = undefined;
    health.lastSuccessAt = now.toISOString();
    if (options.recovery) schedule("health", health, { kind: "recovery" }, true);
    else {
      for (const delivery of Object.values(health.channels)) {
        delivery.notice = "recovery";
        delivery.sentLevel = 0;
      }
      saveAlertState(accountId, "health", health);
    }
    const metrics = quotaMetrics(observation.snapshot, options.usageThresholds);
    const balance = balanceMetric(observation.snapshot, options.balanceThreshold);
    if (balance) metrics.push(balance);
    for (const metric of metrics) {
      const state = getAlertState<AlertState>(accountId, metric.key) ?? { level: 0, channels: {} };
      state.level = metric.level;
      schedule(metric.key, state, metric.notice);
    }
  } else if (observation.issue) {
    health.failures = Math.min((health.failures ?? 0) + 1, 1_000_000);
    health.firstFailureAt ??= now.toISOString();
    const auth = observation.issue.kind === "credentials" || observation.issue.kind === "refresh_rejected";
    health.level = auth ? 2 : health.failures >= options.failureThreshold ? 1 : 0;
    health.issueKind = observation.issue.kind;
    const notice: AlertNotice = auth
      ? { kind: "credentials", refreshRejected: observation.issue.kind === "refresh_rejected", lastSuccessAt: health.lastSuccessAt }
      : { kind: "failure", failures: health.failures, rateLimited: observation.issue.kind === "rate_limit", lastSuccessAt: health.lastSuccessAt };
    schedule("health", health, notice);
  } else if (observation.staleSince && time - Date.parse(observation.staleSince) >= options.staleSeconds * 1000) {
    // An existing error alert already explains stale data; do not add a second warning.
    if (health.level === 0 || health.issueKind === "stale") {
      health.level = 1;
      health.issueKind = "stale";
      schedule("health", health, { kind: "stale", since: observation.staleSince });
    }
  }

  await Promise.all([...plans.values()].map(async ({ channel, notices, receipts }) => {
    const isCurrent = (receipt: Receipt) => getAlertState<AlertState>(accountId, receipt.key)?.channels[channel.name]?.lease?.token === receipt.token;
    const active = receipts.filter(isCurrent);
    if (!active.length) return;
    let ok = false;
    try {
      ok = await send(channel, buildAlertMessage(provider, notices, now, options.dashboardUrl, options.accountLabel), () => receipts.every(isCurrent));
    } catch {
      console.error(`[notify] ${channel.name} alert delivery failed`);
    }
    for (const receipt of receipts) {
      const state = getAlertState<AlertState>(accountId, receipt.key);
      const delivery = state?.channels[channel.name];
      if (!state || !delivery || delivery.lease?.token !== receipt.token) continue;
      delivery.lease = undefined;
      if (ok) {
        delivery.sentAt = time;
        delivery.sentLevel = receipt.recovery ? 0 : receipt.level;
        delivery.notice = receipt.recovery ? "recovery" : "problem";
      }
      saveAlertState(accountId, receipt.key, state);
    }
  }));
}
