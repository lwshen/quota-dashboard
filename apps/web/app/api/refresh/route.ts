import { NextResponse } from "next/server";
import { isProvider } from "@quota/core";
import { fetchAllConfigured, fetchAndStore } from "@/server/usage/fetcher";
import { getCredential } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const text = await req.text();
  if (text.trim()) {
    let body: unknown;
    try { body = JSON.parse(text); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
    const accountId = body && typeof body === "object" ? ("accountId" in body ? body.accountId : "provider" in body ? body.provider : null) : null;
    if (typeof accountId !== "string") {
      return NextResponse.json({ error: "需要有效的 accountId" }, { status: 400 });
    }
    if (!("accountId" in (body as object)) && !isProvider(accountId)) return NextResponse.json({ error: "unknown provider" }, { status: 400 });
    const credential = getCredential(accountId);
    if (!credential?.enabled) return NextResponse.json({ error: "请先配置凭据并启用账号" }, { status: 409 });
    const result = await fetchAndStore(accountId);
    return NextResponse.json({ ok: true, result });
  }
  await fetchAllConfigured();
  return NextResponse.json({ ok: true });
}
