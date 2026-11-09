import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isProvider } from "@quota/core";
import { SESSION_COOKIE, verifySessionToken } from "@/runtime/auth";
import { ENV } from "@/runtime/env";
import { getAccount, historyInRange } from "@/server/storage";
import { buildUsageHistory, HISTORY_RANGES, type HistoryRange } from "@/shared/usage-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const accountId = params.get("accountId") ?? params.get("provider");
  const range = params.get("range") ?? "24h";
  if (!accountId || !Object.hasOwn(HISTORY_RANGES, range)) {
    return NextResponse.json({ error: "需要有效的账号和时间范围（24h、7d、30d）" }, { status: 400 });
  }
  if (!params.has("accountId") && !isProvider(accountId)) return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  const account = getAccount(accountId);
  if (!account || !account.enabled) {
    return NextResponse.json({ error: "该账号不存在或已停用" }, { status: 404 });
  }
  const authed = ENV.authDisabled || await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  const now = Date.now();
  const from = new Date(now - HISTORY_RANGES[range as HistoryRange]);
  const history = buildUsageHistory(account.provider, historyInRange(accountId, from, new Date(now)), {
    range: range as HistoryRange, now, pollIntervalSeconds: ENV.pollInterval, includeCosts: authed,
  });
  return NextResponse.json({ ...history, accountId }, { headers: { "Cache-Control": "private, no-store" } });
}
