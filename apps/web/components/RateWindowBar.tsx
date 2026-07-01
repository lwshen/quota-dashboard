import type { RateWindow } from "@quota/core";
import { barColor, extractFraction, formatCountdown } from "@/lib/format";

export function RateWindowBar({
  title,
  sub,
  window: w,
  now,
  indeterminate = false,
}: {
  title: string;
  sub?: string | null;
  window: RateWindow;
  now: number;
  /** Usage isn't trustworthy (e.g. limit unknown / usageKnown=false): show metadata, no fill. */
  indeterminate?: boolean;
}) {
  const used = Math.round(w.usedPercent);
  const frac = extractFraction(w.resetDescription);
  return (
    <div className="meter">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="mlbl">
          {title}
          {sub ? <small>{sub}</small> : null}
        </span>
        <span className="mono mval">{indeterminate ? "未知 · unknown" : `${used}%${frac ? ` · ${frac}` : ""}`}</span>
      </div>
      {indeterminate ? null : (
        <div className="bar">
          <i style={{ width: `${Math.min(100, Math.max(0, used))}%`, background: barColor(used) }} />
        </div>
      )}
      {w.resetsAt ? (
        <div className="reset">
          重置 <b className="mono">{formatCountdown(w.resetsAt, now)}</b>
        </div>
      ) : null}
    </div>
  );
}
