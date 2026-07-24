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
  /** Only report lanes that had reached this used% before resetting. Default 80; 0 reports every reset. */
  minUsedPercent?: number;
}

const STANDARD_LANES = ["primary", "secondary", "tertiary"] as const;

function isReset(prev: RateWindow, next: RateWindow, minUsedPercent: number): boolean {
  // Masked placeholder percentages (e.g. kimi when upstream omits limit/used) are not comparable.
  if (prev.usageKnown === false || next.usageKnown === false) return false;
  // A lane whose window identity changed (provider lane reassignment, sonnet↔opus switch)
  // holds two different quotas — a drop between them is not a reset.
  if (prev.windowMinutes != null && next.windowMinutes != null && prev.windowMinutes !== next.windowMinutes) {
    return false;
  }
  if (prev.sourceKey && next.sourceKey && prev.sourceKey !== next.sourceKey) return false;
  if (prev.usedPercent < minUsedPercent) return false;
  // Identical resetsAt means the window has not rolled over yet.
  if (prev.resetsAt && next.resetsAt && prev.resetsAt === next.resetsAt) return false;
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

  const events: QuotaResetEvent[] = [];
  for (const lane of STANDARD_LANES) {
    const p = prev[lane];
    const n = next[lane];
    if (!p || !n || !isReset(p, n, minUsedPercent)) continue;
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
    if (!isReset(p.window, ex.window, minUsedPercent)) continue;
    events.push(eventFrom(next.provider, ex.id, ex.title, p.window, ex.window));
  }
  return events;
}
