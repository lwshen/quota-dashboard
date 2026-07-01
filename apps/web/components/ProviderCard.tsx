import type { ProviderCostSnapshot, UsageSnapshot } from "@quota/core";
import { RateWindowBar } from "./RateWindowBar";
import { computeBadge, laneMeta, parseValueBlock, splitLabel } from "@/lib/format";

export interface ProviderView {
  provider: string;
  label: string;
  accentColor: string | null;
  producesRateWindows: boolean;
  snapshot: UsageSnapshot | null;
  error: string | null;
  fetchedAt: string | null;
}

// The exact string fetchAndStore stores when no credential is configured.
const NOT_CONFIGURED = "未配置凭据";

function costMain(cost: ProviderCostSnapshot): string {
  const ccy = cost.currencyCode ? ` ${cost.currencyCode}` : "";
  // Balance-shaped cost (e.g. Codex credits): `limit` holds the available balance, used is 0.
  if (cost.limit > 0 && cost.used === 0 && /balance/i.test(cost.period ?? "")) {
    return `${cost.limit.toFixed(2)}${ccy}`;
  }
  if (cost.limit > 0) return `${cost.used.toFixed(2)} / ${cost.limit.toFixed(2)}${ccy}`;
  // limit === 0 means unlimited/unknown cap (per model.ts) — keep the ∞ affordance.
  return cost.used > 0 ? `${cost.used.toFixed(2)} / ∞${ccy}` : `∞${ccy}`;
}

export function ProviderCard({
  view,
  now,
  authed,
  onConfigure,
}: {
  view: ProviderView;
  now: number;
  authed: boolean;
  onConfigure?: (provider: string) => void;
}) {
  const s = view.snapshot;
  const { name, tag } = splitLabel(view.label);
  const accent = view.accentColor ?? "var(--faint)";

  // Main lanes carry trustworthy usage only when the snapshot confidence says so; e.g. Kimi
  // reports dataConfidence "percentOnly" with a coerced 0% when the weekly limit is unknown.
  const mainTrusted = s?.dataConfidence === "exact" || s?.dataConfidence === "estimated";
  const windows: {
    key: string;
    title: string;
    sub: string | null;
    window: NonNullable<UsageSnapshot["primary"]>;
    indeterminate: boolean;
  }[] = [];
  if (s?.primary) windows.push({ key: "primary", ...laneMeta(view.provider, "primary"), window: s.primary, indeterminate: !mainTrusted });
  if (s?.secondary) windows.push({ key: "secondary", ...laneMeta(view.provider, "secondary"), window: s.secondary, indeterminate: !mainTrusted });
  if (s?.tertiary) windows.push({ key: "tertiary", ...laneMeta(view.provider, "tertiary"), window: s.tertiary, indeterminate: !mainTrusted });
  // NamedRateWindow.usageKnown === false means "show reset metadata, not real consumption".
  for (const e of s?.extraRateWindows ?? []) {
    windows.push({ key: `x-${e.id}`, title: e.title, sub: null, window: e.window, indeterminate: e.usageKnown === false });
  }

  const hasWindows = windows.length > 0;
  const metered = windows.filter((w) => !w.indeterminate).map((w) => w.window.usedPercent);
  const maxUsed = metered.length ? Math.max(...metered) : null;
  const loginText = s?.identity?.loginMethod ?? null;
  const email = s?.identity?.accountEmail ?? null;
  const cost = s?.providerCost ?? null;

  const hasValueData = !!loginText || !!cost;
  const hasData = hasWindows || hasValueData;
  // A real fetch error (not the "not configured" sentinel) with nothing to show.
  const errorState = !hasData && !!view.error && view.error !== NOT_CONFIGURED;
  const rateLimited = errorState && /rate limit/i.test(view.error ?? "");

  const badge = computeBadge({
    errorState,
    maxUsedPercent: maxUsed,
    hasWindows,
    hasValueData,
    snapshotPresent: !!s,
    authed,
  });

  return (
    <div className="qcard">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row" style={{ gap: 9 }}>
          <span className="pdot" style={{ background: accent }} />
          <span className="pname">{name}</span>
          {tag ? <span className="ptag">{tag}</span> : null}
        </div>
        <span className={`badge ${badge.tone}`}>
          {badge.icon} {badge.label}
        </span>
      </div>

      {email ? <div className="subident">{email}</div> : null}

      {errorState ? (
        <div className="warnstate">
          <div className="warnicon">⚠</div>
          <div className="warntext">
            {rateLimited ? "配额受限 · rate limited" : "获取失败 · fetch error"}
            <br />
            <span className="warnsub">{rateLimited ? "稍后自动重试 · retries automatically" : view.error}</span>
          </div>
        </div>
      ) : hasWindows ? (
        <>
          {windows.map((w) => (
            <RateWindowBar key={w.key} title={w.title} sub={w.sub} window={w.window} now={now} indeterminate={w.indeterminate} />
          ))}
          {loginText ? <div className="subident">{loginText}</div> : null}
          {cost ? (
            <div className="cost">
              {cost.period ?? "额度"} · <span className="mono">{costMain(cost)}</span>
            </div>
          ) : null}
        </>
      ) : loginText ? (
        (() => {
          const { label, value, sub } = parseValueBlock(loginText);
          return (
            <div className="valblock">
              <div className="vlbl">{label}</div>
              <div className="vval mono">{value}</div>
              {sub ? <div className="vsub">{sub}</div> : null}
            </div>
          );
        })()
      ) : cost ? (
        <div className="valblock">
          <div className="vlbl">{cost.period ?? "额度 · Cost"}</div>
          <div className="vval mono">{costMain(cost)}</div>
        </div>
      ) : (
        <div className="emptystate">
          {!s
            ? "未配置 · not configured"
            : authed
              ? "暂无用量数据 · no usage data"
              : "登录以查看 · sign in to view"}
        </div>
      )}

      <div className="stamp">
        {onConfigure ? (
          <button type="button" className="cfglink" onClick={() => onConfigure(view.provider)}>
            配置 · configure
          </button>
        ) : (
          <span />
        )}
        <span>{view.fetchedAt ? `更新 ${new Date(view.fetchedAt).toLocaleTimeString()}` : "—"}</span>
      </div>
    </div>
  );
}
