// Quota-reset detection over two consecutive UsageSnapshots of the same provider.
// Pure and side-effect free; the web app decides what to do with the events.

import type { NamedRateWindow, RateWindow, UsageProvider, UsageSnapshot } from "./model";

export interface QuotaResetEvent {
  provider: UsageProvider;
  /** "primary" | "secondary" | "tertiary", or NamedRateWindow.id for extra windows. */
  laneId: string;
  /** NamedRateWindow.title for extra windows; null for standard lanes (labels live in the UI layer). */
  laneTitle: string | null;
  windowMinutes: number | null;
  previousUsedPercent: number;
  currentUsedPercent: number;
  /** When the freshly granted window resets again (ISO), if known. */
  resetsAt: string | null;
}

export interface ResetDetectionOptions {
  /**
   * Only report lanes that had reached this used% before resetting. Default 80; 0 reports
   * every reset. Weekly-or-longer windows are exempt: their resets are always reported.
   */
  minUsedPercent?: number;
}

const STANDARD_LANES = ["primary", "secondary", "tertiary"] as const;

const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

/**
 * How far past the elapsed poll gap `resetsAt` must move before a weekly usage drop counts
 * as an early reset. Providers that recompute `resetsAt` as now+remaining advance it by
 * roughly the gap itself, so only the excess over that is evidence of a restarted window.
 */
const EARLY_RESET_ADVANCE_MARGIN_MS = 60 * 60 * 1000;

/** Wall-clock between two snapshots, used to size the drift a provider can show. */
function elapsedBetween(prev: UsageSnapshot, next: UsageSnapshot): number {
  const a = Date.parse(prev.updatedAt);
  const b = Date.parse(next.updatedAt);
  // Unusable stamps leave only the flat margin below; still far stricter than a bare drop.
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  // History can persist out of order (see historyFor), so a negative gap is not meaningful.
  return Math.max(0, b - a);
}

function isReset(prev: RateWindow, next: RateWindow, minUsedPercent: number, elapsedMs: number): boolean {
  // Masked placeholder percentages (e.g. kimi when upstream omits limit/used) are not comparable.
  if (prev.usageKnown === false || next.usageKnown === false) return false;
  // A lane whose window identity changed (provider lane reassignment, sonnet↔opus switch)
  // holds two different quotas — a drop between them is not a reset.
  if (prev.windowMinutes != null && next.windowMinutes != null && prev.windowMinutes !== next.windowMinutes) {
    return false;
  }
  if (prev.sourceKey && next.sourceKey && prev.sourceKey !== next.sourceKey) return false;
  // Identical resetsAt means the window has not rolled over yet.
  if (prev.resetsAt && next.resetsAt && prev.resetsAt === next.resetsAt) return false;

  const windowMinutes = next.windowMinutes ?? prev.windowMinutes;
  const weekly = windowMinutes != null && windowMinutes >= WEEKLY_WINDOW_MINUTES;
  if (weekly) {
    // Weekly quotas reset rarely and matter regardless of how much had been used,
    // so every rollover is reported (minUsedPercent does not apply).
    const drop = prev.usedPercent - next.usedPercent;
    const sharpCut = drop >= 5 && next.usedPercent <= prev.usedPercent / 2;
    const p = Date.parse(prev.resetsAt ?? "");
    const n = Date.parse(next.resetsAt ?? "");
    if (Number.isFinite(p) && Number.isFinite(n)) {
      // Natural expiry advances resetsAt by ~the window length, whatever the usage was.
      const advance = n - p;
      if (advance >= (windowMinutes * 60_000) / 2) return true;
      // An early refresh restarts the window mid-flight, so resetsAt advances by far less
      // than that — but still well clear of the poll gap. The cut cannot stand on its own:
      // a sliding window sheds a burst that aged out of its tail and can halve with no
      // rollover, and the identical-resetsAt guard above misses that for a drifting provider.
      return advance - elapsedMs >= EARLY_RESET_ADVANCE_MARGIN_MS && sharpCut;
    }
    // No comparable timestamps: the cut is all there is to go on, with no way to
    // corroborate it. Weekly decay is ~0.05% per 5min poll when usage is evenly spread.
    return sharpCut;
  }

  if (prev.usedPercent < minUsedPercent) return false;
  // A genuine reset drops sharply. Rolling-window decay between two polls is bounded
  // by pollInterval/windowLength (~2% for a 5h window at 5min polls), far below these cuts.
  const drop = prev.usedPercent - next.usedPercent;
  return drop >= 20 && next.usedPercent <= prev.usedPercent / 2;
}

function eventFrom(
  provider: UsageProvider,
  laneId: string,
  laneTitle: string | null,
  prev: RateWindow,
  next: RateWindow,
): QuotaResetEvent {
  return {
    provider,
    laneId,
    laneTitle,
    windowMinutes: next.windowMinutes ?? prev.windowMinutes ?? null,
    previousUsedPercent: prev.usedPercent,
    currentUsedPercent: next.usedPercent,
    resetsAt: next.resetsAt ?? null,
  };
}

export function detectQuotaResets(
  prev: UsageSnapshot,
  next: UsageSnapshot,
  opts: ResetDetectionOptions = {},
): QuotaResetEvent[] {
  if (prev.provider !== next.provider) return [];
  // Trust is gated per lane via RateWindow.usageKnown (see isReset), not per snapshot:
  // dataConfidence describes specific lanes and would drop genuine resets on others.
  const raw = opts.minUsedPercent;
  const minUsedPercent = typeof raw === "number" && Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 80;
  const elapsedMs = elapsedBetween(prev, next);

  const events: QuotaResetEvent[] = [];
  for (const lane of STANDARD_LANES) {
    const p = prev[lane];
    const n = next[lane];
    if (!p || !n || !isReset(p, n, minUsedPercent, elapsedMs)) continue;
    events.push(eventFrom(next.provider, lane, null, p, n));
  }

  const prevExtras = new Map<string, NamedRateWindow>(
    (prev.extraRateWindows ?? []).filter((w) => w.usageKnown).map((w) => [w.id, w]),
  );
  for (const ex of next.extraRateWindows ?? []) {
    if (!ex.usageKnown) continue;
    const p = prevExtras.get(ex.id);
    // Same id can carry different quotas over time (claude "weekly-scoped" tracks whichever
    // model limit is active; the title names it) — a changed title means a different window.
    if (!p || p.title !== ex.title) continue;
    if (!isReset(p.window, ex.window, minUsedPercent, elapsedMs)) continue;
    events.push(eventFrom(next.provider, ex.id, ex.title, p.window, ex.window));
  }
  return events;
}
