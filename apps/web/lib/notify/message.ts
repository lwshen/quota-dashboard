import type { QuotaResetEvent } from "@quota/core";
import { getDescriptor } from "@quota/core";
import { laneMeta, splitLabel } from "../format";
import type { NotifyMessage } from "./types";

function laneLabel(e: QuotaResetEvent): string {
  if (e.laneTitle) return e.laneTitle;
  if (e.laneId === "primary" || e.laneId === "secondary" || e.laneId === "tertiary") {
    return laneMeta(e.provider, e.laneId, e.windowMinutes).title;
  }
  return e.laneId;
}

/** Absolute time in the server's timezone (set TZ in deployment for local times). */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtEta(iso: string, now: Date): string | null {
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMin = Math.round(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  if (m || parts.length === 0) parts.push(`${m} 分钟`);
  return parts.join(" ");
}

export function buildQuotaResetMessage(events: QuotaResetEvent[], now: Date): NotifyMessage {
  const lines = events.map((e) => {
    const name = splitLabel(getDescriptor(e.provider).label).name;
    const usage = `${Math.round(e.previousUsedPercent)}% → ${Math.round(e.currentUsedPercent)}%`;
    let line = `**${name} · ${laneLabel(e)}** 已重置，新额度可用（用量 ${usage}）`;
    if (e.resetsAt) {
      const eta = fmtEta(e.resetsAt, now);
      line += `\n下次重置：${fmtTime(e.resetsAt)}${eta ? `（约 ${eta} 后）` : ""}`;
    }
    return line;
  });
  return { title: "✅ 配额已重置", lines };
}

export function buildTestMessage(now: Date): NotifyMessage {
  return {
    title: "🔔 通知测试",
    lines: ["Quota Dashboard 通知渠道已配置成功。", `发送时间：${fmtTime(now.toISOString())}`],
  };
}

export function buildStartupMessage(now: Date, opts: { pollIntervalSeconds: number; pollerEnabled: boolean }): NotifyMessage {
  const polling = opts.pollerEnabled ? `轮询间隔：${opts.pollIntervalSeconds} 秒` : "后台轮询已禁用（ENABLE_POLLER=false）";
  return {
    title: "🚀 服务已启动",
    lines: ["Quota Dashboard 已启动，配额重置监控运行中。", polling, `启动时间：${fmtTime(now.toISOString())}`],
  };
}
