import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isProvider } from "@quota/core";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { ENV } from "@/lib/env";
import { historyInRange, listProviderSettings } from "@/lib/store";
import { buildUsageHistory, HISTORY_RANGES, type HistoryRange } from "@/lib/usage-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const provider = params.get("provider");
  const range = params.get("range") ?? "24h";
  if (!provider || !isProvider(provider) || !Object.hasOwn(HISTORY_RANGES, range)) {
    return NextResponse.json({ error: "需要有效的渠道和时间范围（24h、7d、30d）" }, { status: 400 });
  }
  if (listProviderSettings().get(provider) === false) {
    return NextResponse.json({ error: "该渠道已停用" }, { status: 404 });
  }
  const authed = ENV.authDisabled || await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  const now = Date.now();
  const from = new Date(now - HISTORY_RANGES[range as HistoryRange]);
  const history = buildUsageHistory(provider, historyInRange(provider, from, new Date(now)), {
    range: range as HistoryRange, now, pollIntervalSeconds: ENV.pollInterval, includeCosts: authed,
  });
  return NextResponse.json(history, { headers: { "Cache-Control": "private, no-store" } });
}
