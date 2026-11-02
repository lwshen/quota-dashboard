import { NextResponse } from "next/server";
import { isProvider } from "@quota/core";
import { fetchAllConfigured, fetchAndStore } from "@/lib/fetcher";
import { getCredential } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const text = await req.text();
  if (text.trim()) {
    let body: unknown;
    try { body = JSON.parse(text); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
    if (!body || typeof body !== "object" || !("provider" in body) || typeof body.provider !== "string" || !isProvider(body.provider)) {
      return NextResponse.json({ error: "unknown provider" }, { status: 400 });
    }
    const credential = getCredential(body.provider);
    if (!credential?.enabled) return NextResponse.json({ error: "请先配置凭据并启用渠道" }, { status: 409 });
    const result = await fetchAndStore(body.provider);
    return NextResponse.json({ ok: true, result });
  }
  await fetchAllConfigured();
  return NextResponse.json({ ok: true });
}
