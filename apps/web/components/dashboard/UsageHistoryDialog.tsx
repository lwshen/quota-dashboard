"use client";

import { useEffect, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useModalDialog } from "@/client/hooks";
import type { HistoryPoint, HistoryRange, UsageHistory } from "@/shared/usage-history";

const RANGES: { value: HistoryRange; label: string }[] = [
  { value: "24h", label: "近 24 小时" }, { value: "7d", label: "近 7 天" }, { value: "30d", label: "近 30 天" },
];

function formatValue(value: number, unit: string) {
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;
}

export function UsageHistoryDialog({ accountId, label, authed, onClose }: {
  accountId: string; label: string; authed: boolean; onClose: () => void;
}) {
  const dialog = useModalDialog();
  const [range, setRange] = useState<HistoryRange>("24h");
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const errorRef = useRef<HTMLDivElement>(null);
  const restoreRetryFocus = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setHistory(null);
    async function load() {
      try {
        const res = await fetch(`/api/history?accountId=${encodeURIComponent(accountId)}&range=${range}`, {
          cache: "no-store", signal: controller.signal,
        });
        if (!res.ok) throw new Error(res.status === 404 ? "该账号不存在或已停用，请关闭后重新加载看板。" : "历史数据加载失败，请重试。");
        const data: UsageHistory = await res.json();
        if (!controller.signal.aborted) setHistory(data);
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "历史数据加载失败，请重试。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [accountId, range, authed, attempt]);

  useEffect(() => {
    if (!loading && restoreRetryFocus.current) {
      (errorRef.current ?? dialog.current?.querySelector<HTMLSelectElement>("select"))?.focus();
      restoreRetryFocus.current = false;
    }
  }, [loading, dialog]);

  const selected = history?.series.find((series) => series.id === selectedId) ?? history?.series[0];
  const resets = selected?.points.filter((point) => point.reset && point.value != null) ?? [];
  const markers = selected?.points.filter((point, i, points) => point.value != null && (point.reset
    || (points[i - 1]?.value == null && points[i + 1]?.value == null))) ?? [];
  const dateTick = (time: number) => new Date(time).toLocaleString("zh-CN", range === "24h"
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "numeric", day: "numeric" });

  return (
    <dialog ref={dialog} className="modal management-dialog history-dialog" aria-labelledby="history-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="management-header">
        <div>
          <h2 id="history-title" className="modal-title">历史曲线</h2>
          <p className="modal-sub">{label}</p>
        </div>
        <button type="button" className="tgl" autoFocus onClick={onClose} aria-label="关闭历史曲线">关闭</button>
      </div>
      <div className="management-body history-body">
        <div className="history-ranges" role="group" aria-label="历史时间范围">
          {RANGES.map((item) => <button key={item.value} type="button" className="tgl" aria-pressed={range === item.value}
            onClick={() => setRange(item.value)}>{item.label}</button>)}
        </div>
        <div aria-busy={loading}>
          {loading ? <div className="history-state" role="status">正在加载历史数据…</div>
            : error ? <div className="history-state history-error" role="alert" ref={errorRef} tabIndex={-1}>
              <p>{error}</p>
              <button type="button" className="tgl" onClick={() => { restoreRetryFocus.current = true; setAttempt((n) => n + 1); }}>重新加载</button>
            </div>
            : !history || !selected ? <div className="history-state" role="status">
              <p>该时间范围内暂无可绘制的历史数据。</p>
              <p className="management-help">采集到有效用量后会自动积累记录，可尝试更长的时间范围。{!authed ? "余额历史需登录后查看。" : ""}</p>
            </div>
            : <>
              <label className="history-select-label" htmlFor="history-metric">查看指标
                <select id="history-metric" className="field" value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
                  {history.series.map((series) => <option key={series.id} value={series.id}>{series.title}{series.unit !== "%" && series.unit ? `（${series.unit}）` : ""}</option>)}
                </select>
              </label>
              <dl className="history-stats">
                {[
                  { title: "最近记录", value: selected.latest }, { title: "最低", value: selected.min }, { title: "最高", value: selected.max },
                ].map((stat) => <div key={stat.title}><dt>{stat.title}</dt><dd className="mono">{formatValue(stat.value, selected.unit)}</dd></div>)}
              </dl>
              <div className="history-chart" aria-label={`${selected.title}历史曲线`}>
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <LineChart data={selected.points} accessibilityLayer margin={{ top: 12, right: 16, left: 0, bottom: 8 }}
                    title={`${label} · ${selected.title}`} desc="使用左右方向键查看各采样点。空白处表示缺少有效数据。">
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="time" type="number" scale="time" domain={[history.from, history.to]} tickFormatter={dateTick}
                      tick={{ fill: "var(--dim)", fontSize: 12 }} tickLine={false} axisLine={false} minTickGap={36} />
                    <YAxis domain={selected.kind === "quota" ? [0, Math.max(100, selected.max)] : ["auto", "auto"]}
                      tickFormatter={(value: number) => selected.unit === "%" ? `${value}%` : value.toLocaleString("zh-CN", { notation: "compact", maximumFractionDigits: 1 })}
                      tick={{ fill: "var(--dim)", fontSize: 12 }} tickLine={false} axisLine={false} width={56} />
                    <Tooltip isAnimationActive={false} cursor={{ stroke: "var(--dim)", strokeDasharray: "3 3" }}
                      content={({ active, payload }) => {
                        const point = payload?.[0]?.payload as HistoryPoint | undefined;
                        return active && point && point.value != null ? <div className="history-tooltip">
                          <time>{new Date(point.time).toLocaleString("zh-CN", { hour12: false })}</time>
                          <strong className="mono">{formatValue(point.value, selected.unit)}</strong>
                          {point.reset && <span>检测到配额重置</span>}
                        </div> : null;
                      }} />
                    <Line type="linear" dataKey="value" name={selected.title} stroke="var(--history-line)" strokeWidth={2}
                      connectNulls={false} isAnimationActive={false} dot={selected.samples === 1 ? { r: 4 } : false} activeDot={{ r: 4 }} />
                    {markers.map((point) => <ReferenceDot key={point.time} x={point.time} y={point.value!} r={4}
                      fill={point.reset ? "var(--history-reset)" : "var(--history-line)"} stroke="var(--panel)" strokeWidth={2} />)}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="history-caption">
                <span>{selected.samples.toLocaleString("zh-CN")} 条有效记录 · {selected.kind === "quota" ? "已用比例" : selected.unit || "数值"}</span>
                {resets.length > 0 && <span className="history-reset-legend"><i />检测到重置</span>}
              </div>
              <p className="management-help history-note">时间按本地时区显示。未知用量和采集空档以断线表示；长时间范围保留关键采样点。</p>
              {selected.samples === 1 && <p className="management-help">目前只有一条有效记录，继续采集后将形成曲线。</p>}
            </>}
        </div>
      </div>
    </dialog>
  );
}
