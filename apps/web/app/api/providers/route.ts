import { NextResponse } from "next/server";
import { isProvider, listDescriptors } from "@quota/core";
import { listProviderSettings, setProviderEnabled } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const settings = listProviderSettings();
  const providers = listDescriptors().map((d) => ({
    provider: d.provider,
    label: d.label,
    enabled: settings.get(d.provider) ?? true,
    producesRateWindows: d.producesRateWindows,
    credentialFields: d.credentialFields,
  }));
  return NextResponse.json({ providers });
}

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !("provider" in body) ||
    typeof body.provider !== "string" || !isProvider(body.provider) ||
    !("enabled" in body) || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "需要有效的 provider 和布尔值 enabled" }, { status: 400 });
  }
  setProviderEnabled(body.provider, body.enabled);
  return NextResponse.json({ ok: true });
}
