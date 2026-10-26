import type { UsageSnapshot } from "@quota/core";
import { RateWindowBar } from "./RateWindowBar";
import { computeBadge, formatCost, laneMeta, parseValueBlock, splitLabel } from "@/lib/format";

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

  // New snapshots report confidence per window; retain the aggregate fallback for older data.
  const mainTrusted = s?.dataConfidence === "exact" || s?.dataConfidence === "estimated";
  const trusted = (window: NonNullable<UsageSnapshot["primary"]>) => window.usageKnown ?? mainTrusted;
  const windows: {
    key: string;
    title: string;
    sub: string | null;
    window: NonNullable<UsageSnapshot["primary"]>;
    indeterminate: boolean;
  }[] = [];
  if (s?.primary)
    windows.push({ key: "primary", ...laneMeta(view.provider, "primary", s.primary.windowMinutes), window: s.primary, indeterminate: !trusted(s.primary) });
  if (s?.secondary)
    windows.push({ key: "secondary", ...laneMeta(view.provider, "secondary", s.secondary.windowMinutes), window: s.secondary, indeterminate: !trusted(s.secondary) });
  if (s?.tertiary)
    windows.push({ key: "tertiary", ...laneMeta(view.provider, "tertiary", s.tertiary.windowMinutes), window: s.tertiary, indeterminate: !trusted(s.tertiary) });
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
          <div className="vval mono">{formatCost(cost)}</div>
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

      {s?.usageBreakdown?.length ? (
        <div className="cost">
          <div>用量明细 · Usage breakdown</div>
          {s.usageBreakdown.map((product) => (
            <div key={product.id} className="row" style={{ justifyContent: "space-between", marginTop: 4 }}>
              <span>{product.title}</span>
              <span className="mono">{Number(product.usedPercent.toFixed(2))}%</span>
            </div>
          ))}
        </div>
      ) : null}
      {cost && (hasWindows || loginText) ? (
        <div className="cost">
          {cost.period ?? "额度"} · <span className="mono">{formatCost(cost)}</span>
        </div>
      ) : null}

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
