// Pure UI formatting helpers shared by the dashboard client components.
// No server-only imports here — this module is bundled into the browser.

export type BadgeTone = "good" | "warn" | "danger" | "muted";

export interface Badge {
  label: string;
  tone: BadgeTone;
  icon: string;
}

/** Wall-clock string for the live header clock. `now` of 0 means "not mounted yet". */
export function formatClock(now: number): string {
  if (!now) return "--:--:--";
  return new Date(now).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

/** Countdown to `resetsAt` as `Nd HH:MM:SS`, matching the design's mono timer. */
export function formatCountdown(resetsAt: string | null | undefined, now: number, showSeconds = true): string {
  if (!resetsAt || !now) return "—";
  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) return "—";
  let s = Math.floor((target - now) / 1000);
  if (s <= 0) return "即将重置";
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const p = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return showSeconds ? `${d}天 ${p(h)}:${p(m)}:${p(s)}` : `${d}天 ${p(h)}:${p(m)}`;
  return showSeconds ? `${p(h)}:${p(m)}:${p(s)}` : `${p(h)}:${p(m)}`;
}

/** Meter fill color by used percent, mirroring the badge thresholds. */
export function barColor(usedPercent: number): string {
  if (usedPercent >= 90) return "var(--danger)";
  if (usedPercent >= 70) return "var(--warn)";
  return "var(--good)";
}

/** Split a descriptor label like "Kimi (Code API)" into name + parenthetical tag. */
export function splitLabel(label: string): { name: string; tag: string | null } {
  const m = label.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (m) return { name: (m[1] ?? label).trim(), tag: (m[2] ?? "").trim() };
  return { name: label, tag: null };
}

/** Meter title + sub-label for a given provider lane. */
export function laneMeta(provider: string, lane: "primary" | "secondary" | "tertiary"): { title: string; sub: string | null } {
  if (lane === "tertiary") return { title: "模型窗口", sub: null };
  if (provider === "claude" || provider === "codex") {
    return lane === "primary" ? { title: "5小时窗口", sub: "5h" } : { title: "7天窗口", sub: "7d" };
  }
  if (provider === "kimi") {
    return lane === "primary" ? { title: "周用量", sub: "Weekly" } : { title: "5小时速率", sub: "Rate" };
  }
  return lane === "primary" ? { title: "主窗口", sub: null } : { title: "次窗口", sub: null };
}

/** Extract a `used/limit` fraction from a reset description (e.g. "Rate: 100/100 per 5h" → "100/100"). */
export function extractFraction(desc: string | null | undefined): string | null {
  if (!desc) return null;
  const m = desc.match(/\d[\d,]*\s*\/\s*\d[\d,]*/);
  return m ? m[0].replace(/\s+/g, "") : null;
}

const VALUE_LABELS: Record<string, string> = {
  Balance: "余额 · Balance",
  Credits: "额度 · Credits",
  Plan: "套餐 · Plan",
};

/** Parse a freeform identity string like "Balance: $128.40 · $5 in deficit" into a value block. */
export function parseValueBlock(text: string): { label: string; value: string; sub: string | null } {
  const segments = text.split(" · ");
  const first = segments[0] ?? text;
  const m = first.match(/^([^:]+):\s*(.*)$/);
  const labelRaw = m ? (m[1] ?? "").trim() : null;
  const valuePart = m ? (m[2] ?? "").trim() : "";
  const value = valuePart || first;
  const sub = segments.slice(1).join(" · ") || null;
  const label = (labelRaw && VALUE_LABELS[labelRaw]) || labelRaw || "状态 · Status";
  return { label, value, sub };
}

/** Derive the status badge from error state and usage. */
export function computeBadge(opts: {
  errorState: boolean;
  /** Highest used% across lanes whose consumption is actually known; null if none. */
  maxUsedPercent: number | null;
  /** Any rate windows present, even ones with indeterminate usage. */
  hasWindows: boolean;
  /** Balance / credits / cost the viewer can see. */
  hasValueData: boolean;
  snapshotPresent: boolean;
  authed: boolean;
}): Badge {
  if (opts.errorState) return { label: "LIMITED", tone: "danger", icon: "⚠" };
  const p = opts.maxUsedPercent;
  if (p != null) {
    if (p >= 100) return { label: "FULL", tone: "danger", icon: "●" };
    if (p >= 90) return { label: "HIGH", tone: "danger", icon: "●" };
    if (p >= 70) return { label: "WARN", tone: "warn", icon: "●" };
    return { label: "OK", tone: "good", icon: "●" };
  }
  // Windows exist but none has trustworthy usage — don't imply a reassuring "OK".
  if (opts.hasWindows) return { label: "未知", tone: "muted", icon: "○" };
  if (opts.hasValueData) return { label: "OK", tone: "good", icon: "●" };
  // Snapshot exists but carries no usage the current viewer can see (identity/cost are
  // admin-only, so anonymous viewers get an empty snapshot for balance providers).
  if (opts.snapshotPresent) return { label: opts.authed ? "空" : "隐藏", tone: "muted", icon: "○" };
  return { label: "未配置", tone: "muted", icon: "○" };
}
