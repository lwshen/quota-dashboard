import { detectQuotaResets, type RateWindow, type UsageProvider, type UsageSnapshot } from "@quota/core";
import { laneMeta } from "./format";

export const HISTORY_RANGES = { "24h": 24 * 60 * 60_000, "7d": 7 * 24 * 60 * 60_000, "30d": 30 * 24 * 60 * 60_000 } as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;

export interface HistoryPoint {
  time: number;
  value: number | null;
  reset: boolean;
}

export interface HistorySeries {
  id: string;
  title: string;
  unit: string;
  kind: "quota" | "balance" | "spend";
  points: HistoryPoint[];
  samples: number;
  latest: number;
  min: number;
  max: number;
}

export interface UsageHistory {
  provider: UsageProvider;
  range: HistoryRange;
  from: number;
  to: number;
  sampleCount: number;
  series: HistorySeries[];
}

interface HistoryEntry { snapshot: UsageSnapshot; fetchedAt: string }
interface Metric { id: string; title: string; kind: HistorySeries["kind"]; unit: string; value: number | null; laneId?: string }
interface SampledPoint extends HistoryPoint { segment: number }
interface Bucket { first: SampledPoint; last: SampledPoint; min?: SampledPoint; max?: SampledPoint; gap?: SampledPoint; reset?: SampledPoint }
interface Accumulator { series: HistorySeries; buckets: Map<number, Bucket>; segment: number; last?: SampledPoint }

function windowMetric(snapshot: UsageSnapshot, lane: string, title: string, window: RateWindow, known?: boolean): Metric {
  const trusted = known ?? window.usageKnown ?? (snapshot.dataConfidence === "exact" || snapshot.dataConfidence === "estimated");
  return {
    id: JSON.stringify([lane, window.sourceKey ?? null, window.windowMinutes ?? null, title]),
    laneId: lane, title, kind: "quota", unit: "%",
    value: trusted && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 ? window.usedPercent : null,
  };
}

function metrics(snapshot: UsageSnapshot, includeCosts: boolean): Metric[] {
  const result: Metric[] = [];
  for (const lane of ["primary", "secondary", "tertiary"] as const) {
    const w = snapshot[lane];
    if (w) {
      const title = w.sourceKey === "seven_day_sonnet" ? "Sonnet (7d)" : w.sourceKey === "seven_day_opus" ? "Opus (7d)"
        : laneMeta(snapshot.provider, lane, w.windowMinutes).title;
      result.push(windowMetric(snapshot, lane, title, w));
    }
  }
  for (const extra of snapshot.extraRateWindows ?? []) {
    result.push(windowMetric(snapshot, `extra:${extra.id}`, extra.title, extra.window, extra.usageKnown && extra.window.usageKnown !== false));
  }
  const cost = includeCosts ? snapshot.providerCost : null;
  if (cost) {
    const unit = cost.currencyCode;
    const balance = cost.balance ?? (cost.used === 0 && /balance/i.test(cost.period ?? "") ? cost.limit : null);
    if (balance != null && Number.isFinite(balance)) {
      result.push({ id: JSON.stringify(["balance", unit]), title: "余额", kind: "balance", unit, value: balance });
    }
    if (Number.isFinite(cost.used) && (cost.used > 0 || (cost.limit > 0 && !/balance/i.test(cost.period ?? "")))) {
      result.push({ id: JSON.stringify(["spend", unit, cost.period ?? null]), title: cost.period ? `${cost.period} · 已用` : "周期已用", kind: "spend", unit, value: cost.used });
    }
  } else if (includeCosts && (snapshot.provider === "moonshot" || snapshot.provider === "rightapi")) {
    // These providers historically stored only a formatted balance. Keep its displayed unit.
    const balance = /^Balance:\s*(.*?)\s*([+-]?\d+(?:\.\d+)?)\s*(?:·|$)/.exec(snapshot.identity?.loginMethod ?? "");
    if (balance && Number.isFinite(Number(balance[2]))) {
      const unit = balance[1]!.trim();
      result.push({ id: JSON.stringify(["balance", unit]), title: "余额", kind: "balance", unit, value: Number(balance[2]) });
    }
  }
  return result;
}

// Keep endpoints, extrema, a gap, and a reset per time bucket instead of averaging away peaks.
function addPoint(acc: Accumulator, input: HistoryPoint, from: number, bucketMs: number) {
  if (input.value == null && acc.last?.value != null) acc.segment++;
  const point: SampledPoint = { ...input, segment: acc.segment };
  const key = Math.floor((point.time - from) / bucketMs);
  const bucket = acc.buckets.get(key) ?? { first: point, last: point };
  bucket.last = point;
  if (point.value == null) bucket.gap ??= point;
  else {
    if (bucket.min?.value == null || point.value < bucket.min.value) bucket.min = point;
    if (bucket.max?.value == null || point.value > bucket.max.value) bucket.max = point;
  }
  if (point.reset) bucket.reset = point;
  acc.buckets.set(key, bucket);
  acc.last = point;
}

export function buildUsageHistory(
  provider: UsageProvider,
  entries: Iterable<HistoryEntry>,
  options: { range: HistoryRange; now: number; pollIntervalSeconds: number; includeCosts: boolean },
): UsageHistory {
  const { range, now, includeCosts } = options;
  const from = now - HISTORY_RANGES[range];
  const result: UsageHistory = { provider, range, from, to: now, sampleCount: 0, series: [] };
  const accumulators = new Map<string, Accumulator>();
  const bucketMs = HISTORY_RANGES[range] / 360;
  const maxGap = Math.max(15 * 60_000, 3 * Math.max(60, options.pollIntervalSeconds) * 1000);
  let previous: HistoryEntry | undefined;
  for (const entry of entries) {
    const time = Date.parse(entry.fetchedAt);
    if (!Number.isFinite(time) || time < from || time > now || entry.snapshot.provider !== provider) continue;
    result.sampleCount++;
    const current = metrics(entry.snapshot, includeCosts);
    const previousMetrics = previous ? metrics(previous.snapshot, false) : [];
    const resetLanes = new Set(previous && time - Date.parse(previous.fetchedAt) <= maxGap
      ? detectQuotaResets(previous.snapshot, entry.snapshot, { minUsedPercent: 0 }).map((event) =>
        event.laneTitle == null ? event.laneId : `extra:${event.laneId}`)
      : []);
    const present = new Set<string>();
    for (const metric of current) {
      present.add(metric.id);
      let acc = accumulators.get(metric.id);
      if (!acc) {
        acc = { series: { id: metric.id, title: metric.title, unit: metric.unit, kind: metric.kind, points: [], samples: 0, latest: 0, min: Infinity, max: -Infinity }, buckets: new Map(), segment: 0 };
        accumulators.set(metric.id, acc);
      }
      if (acc.last && time - acc.last.time > maxGap) {
        addPoint(acc, { time: acc.last.time + 1, value: null, reset: false }, from, bucketMs);
      }
      const reset = metric.value != null && !!metric.laneId && resetLanes.has(metric.laneId)
        && previousMetrics.some((old) => old.id === metric.id && old.value != null);
      addPoint(acc, { time, value: metric.value, reset }, from, bucketMs);
      if (metric.value != null) {
        acc.series.samples++;
        acc.series.latest = metric.value;
        acc.series.min = Math.min(acc.series.min, metric.value);
        acc.series.max = Math.max(acc.series.max, metric.value);
      }
    }
    for (const [id, acc] of accumulators) {
      if (!present.has(id) && acc.last?.value != null) addPoint(acc, { time, value: null, reset: false }, from, bucketMs);
    }
    previous = entry;
  }
  for (const { series, buckets } of accumulators.values()) {
    if (!series.samples) continue;
    const points = new Map<number, SampledPoint>();
    for (const bucket of buckets.values()) {
      for (const point of [bucket.first, bucket.min, bucket.max, bucket.gap, bucket.reset, bucket.last]) {
        if (point) points.set(point.time, point);
      }
    }
    const sampled = [...points.values()].sort((a, b) => a.time - b.time);
    for (let i = 0; i < sampled.length; i++) {
      const point = sampled[i]!;
      const prev = sampled[i - 1];
      // A removed null must never reconnect observations across an unknown interval.
      if (prev && prev.value != null && point.value != null && prev.segment !== point.segment) {
        series.points.push({ time: (prev.time + point.time) / 2, value: null, reset: false });
      }
      series.points.push({ time: point.time, value: point.value, reset: point.reset });
    }
    result.series.push(series);
  }
  return result;
}
