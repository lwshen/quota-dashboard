import { NextResponse } from "next/server";
import { fetchAllConfigured } from "@/lib/fetcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await fetchAllConfigured();
  return NextResponse.json({ ok: true });
}
