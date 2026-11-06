import type { QuotaResetEvent, UsageProvider } from "@quota/core";
import { getDescriptor } from "@quota/core";
import { laneMeta, splitLabel } from "../format";
import type { NotifyMessage } from "./types";
import type { AlertNotice } from "./alerts";

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

export function buildQuotaResetMessage(events: QuotaResetEvent[], now: Date, accountLabel?: string): NotifyMessage {
  const lines = events.map((e) => {
    const name = splitLabel(getDescriptor(e.provider).label).name + (accountLabel ? ` · ${safeText(accountLabel)}` : "");
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

function safeText(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/[<>]/g, "").replace(/[\\*_`\[\]]/g, "\\$&").slice(0, 160);
}

export function buildAlertMessage(provider: UsageProvider, notices: AlertNotice[], now: Date, dashboardUrl?: string, accountLabel?: string): NotifyMessage {
  const name = splitLabel(getDescriptor(provider).label).name;
  const number = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  const lines = notices.map((notice) => {
    if (notice.kind === "quota") {
      return `**${safeText(notice.title)}** 已用 ${number(notice.value)}%（预警阈值 ${number(notice.threshold)}%）`
        + (notice.resetsAt && Number.isFinite(Date.parse(notice.resetsAt)) ? `\n重置时间：${fmtTime(notice.resetsAt)}` : "");
    }
    if (notice.kind === "balance") return `余额 ${number(notice.value)} ${safeText(notice.unit)}，已低于或达到阈值 ${number(notice.threshold)} ${safeText(notice.unit)}。请检查余额或充值。`;
    if (notice.kind === "recovery") return "已重新成功获取用量，渠道恢复正常。";
    if (notice.kind === "stale") return `用量数据长时间未更新。监控起点／最后成功时间：${fmtTime(notice.since)}。请检查服务运行状态和渠道配置。`;
    const last = notice.lastSuccessAt ? `\n最后成功获取：${fmtTime(notice.lastSuccessAt)}` : "\n尚未成功获取用量。";
    if (notice.kind === "credentials") {
      return (notice.refreshRejected ? "凭据自动续期已被永久拒绝。请重新登录并导入完整凭据。"
        : "用量接口拒绝了当前凭据。请检查 Token 是否有效及账户权限，并在账号管理中更新凭据。") + last;
    }
    return `连续 ${notice.failures} 次获取用量失败${notice.rateLimited ? "（上游限流）" : ""}。将继续自动重试，请检查网络及上游服务。${last}`;
  });
  lines.unshift(`**${safeText(name)}${accountLabel ? ` · ${safeText(accountLabel)}` : ""}**`);
  if (dashboardUrl) {
    try {
      const url = new URL(dashboardUrl);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
        url.search = "";
        url.hash = "";
        lines.push(`[打开看板 · 账号管理](${url.href.replace(/\(/g, "%28").replace(/\)/g, "%29")})`);
      }
    } catch { /* Ignore invalid optional links. */ }
  }
  lines.push(`检测时间：${fmtTime(now.toISOString())}`);
  const title = notices.some((notice) => notice.kind === "credentials") ? "⚠ 凭据需要处理"
    : notices.some((notice) => notice.kind === "failure" || notice.kind === "stale") ? "⚠ 渠道获取异常"
    : notices.every((notice) => notice.kind === "recovery") ? "✅ 渠道已恢复" : "⚠ 额度不足预警";
  return { title, lines, severity: notices.every((notice) => notice.kind === "recovery") ? "success" : "warning" };
}

export function buildStartupMessage(now: Date, opts: { pollIntervalSeconds: number; pollerEnabled: boolean }): NotifyMessage {
  const polling = opts.pollerEnabled ? `轮询间隔：${opts.pollIntervalSeconds} 秒` : "后台轮询已禁用（ENABLE_POLLER=false）";
  return {
    title: "🚀 服务已启动",
    lines: ["Quota Dashboard 已启动。", polling, `启动时间：${fmtTime(now.toISOString())}`],
  };
}
