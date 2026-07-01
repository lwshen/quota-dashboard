import type { UsageSnapshot } from "@quota/core";
import { RateWindowBar } from "./RateWindowBar";

export interface ProviderView {
  provider: string;
  label: string;
  producesRateWindows: boolean;
  snapshot: UsageSnapshot | null;
  error: string | null;
  fetchedAt: string | null;
  /** Credential comes from a config file source (env QUOTA_<P>_FILE), not the DB. */
  external?: boolean;
  externalWritable?: boolean;
}

function laneTitle(provider: string, lane: "primary" | "secondary"): string {
  if (provider === "claude" || provider === "codex") return lane === "primary" ? "5 小时窗口" : "7 天窗口";
  if (provider === "kimi") return lane === "primary" ? "周用量" : "5 小时速率";
  return lane === "primary" ? "主窗口" : "次窗口";
}

export function ProviderCard({ view, onConfigure }: { view: ProviderView; onConfigure?: (provider: string) => void }) {
  const s = view.snapshot;
  const textOnly = s?.identity?.loginMethod && !s.primary && !s.secondary;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="font-medium">{view.label}</div>
          {s?.identity?.accountEmail && <div className="text-xs text-neutral-500">{s.identity.accountEmail}</div>}
        </div>
        {view.external ? (
          <span
            className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400"
            title={`由环境变量配置文件管理（${view.externalWritable ? "可写" : "只读"}）`}
          >
            配置文件{view.externalWritable ? "" : " · 只读"}
          </span>
        ) : (
          onConfigure && (
            <button
              onClick={() => onConfigure(view.provider)}
              className="text-xs text-neutral-400 transition-colors hover:text-neutral-100"
            >
              配置
            </button>
          )
        )}
      </div>

      {view.error && <div className="text-xs text-red-400">⚠ {view.error}</div>}

      {s && (
        <div className="space-y-3">
          {s.primary && <RateWindowBar title={laneTitle(view.provider, "primary")} window={s.primary} />}
          {s.secondary && <RateWindowBar title={laneTitle(view.provider, "secondary")} window={s.secondary} />}
          {s.tertiary && <RateWindowBar title="模型窗口" window={s.tertiary} />}
          {s.extraRateWindows?.map((w) => <RateWindowBar key={w.id} title={w.title} window={w.window} />)}

          {s.providerCost && (
            <div className="text-xs text-neutral-400">
              花费/额度：{s.providerCost.used.toFixed(2)} /{" "}
              {s.providerCost.limit ? s.providerCost.limit.toFixed(2) : "∞"} {s.providerCost.currencyCode}
            </div>
          )}
          {textOnly && <div className="text-sm text-neutral-200">{s.identity?.loginMethod}</div>}
        </div>
      )}

      {!s && !view.error && <div className="text-xs text-neutral-500">未配置 / 暂无数据</div>}

      {view.fetchedAt && (
        <div className="mt-auto text-[11px] text-neutral-600">
          更新于 {new Date(view.fetchedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
