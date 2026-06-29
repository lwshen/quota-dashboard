import type { RateWindow } from "@quota/core";

function formatReset(resetsAt?: string | null): string {
  if (!resetsAt) return "";
  const diff = new Date(resetsAt).getTime() - Date.now();
  if (Number.isNaN(diff)) return "";
  if (diff <= 0) return "即将重置";
  const totalMin = Math.floor(diff / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}天${hours}小时后重置`;
  if (hours > 0) return `${hours}小时${mins}分后重置`;
  return `${mins}分后重置`;
}

export function RateWindowBar({ title, window }: { title: string; window: RateWindow }) {
  const used = Math.round(window.usedPercent);
  const color = used >= 90 ? "bg-red-500" : used >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs text-neutral-400">
        <span>{title}</span>
        <span className="tabular-nums">
          {used}%{window.resetDescription ? ` · ${window.resetDescription}` : ""}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
        <div className={`h-full ${color} transition-all`} style={{ width: `${Math.min(100, used)}%` }} />
      </div>
      {window.resetsAt && <div className="text-[11px] text-neutral-500">{formatReset(window.resetsAt)}</div>}
    </div>
  );
}
