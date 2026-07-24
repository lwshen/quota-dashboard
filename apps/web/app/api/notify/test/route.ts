import { NextResponse } from "next/server";
import { notificationsEnabled, sendTestNotification } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  if (!notificationsEnabled()) {
    return NextResponse.json({ ok: false, error: "未配置任何通知渠道（请设置 FEISHU_WEBHOOK_URL）" }, { status: 400 });
  }
  const channels = await sendTestNotification(new Date());
  const ok = channels.every((c) => c.ok);
  return NextResponse.json({ ok, channels }, { status: ok ? 200 : 502 });
}
