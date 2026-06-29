import { NextResponse } from "next/server";
import type { ProviderCredentials, SourceMode } from "@quota/core";
import { getDescriptor, isProvider } from "@quota/core";
import { deleteCredential, listCredentials, saveCredential } from "@/lib/store";
import { fetchAndStore } from "@/lib/fetcher";
import { assertSafeBaseUrl } from "@/lib/ssrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Never return any secret.
export async function GET() {
  const credentials = listCredentials().map((c) => ({
    provider: c.provider,
    enabled: c.enabled,
    mode: c.mode,
    configuredKeys: Object.entries(c.credentials)
      .filter(([, v]) => v != null && v !== "")
      .map(([k]) => k),
    updatedAt: c.updatedAt,
  }));
  return NextResponse.json({ credentials });
}

export async function POST(req: Request) {
  let body: { provider?: string; mode?: string; fields?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const provider = body.provider ?? "";
  if (!isProvider(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 400 });

  const desc = getDescriptor(provider);
  const mode = (body.mode as SourceMode) ?? "auto";
  const fields = body.fields ?? {};

  const creds: ProviderCredentials = {};
  const extra: Record<string, string> = {};
  for (const f of desc.credentialFields) {
    const val = fields[f.key];
    if (val == null || val === "") {
      if (f.required) return NextResponse.json({ error: `缺少必填字段: ${f.label}` }, { status: 400 });
      continue;
    }
    if (typeof f.key === "string" && f.key.startsWith("extra.")) {
      extra[f.key.slice(6)] = String(val);
    } else {
      (creds as Record<string, unknown>)[f.key] = String(val);
    }
  }
  if (Object.keys(extra).length) creds.extra = extra;

  // SSRF: baseUrlOverride must be a public https URL.
  if (creds.baseUrlOverride) {
    try {
      await assertSafeBaseUrl(creds.baseUrlOverride);
    } catch (e) {
      return NextResponse.json({ error: `Base URL 不被接受: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
    }
  }

  const now = new Date();
  saveCredential(provider, mode, creds, now);
  const result = await fetchAndStore(provider);
  return NextResponse.json({ ok: true, result });
}

export async function DELETE(req: Request) {
  const provider = new URL(req.url).searchParams.get("provider") ?? "";
  if (!isProvider(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  deleteCredential(provider);
  return NextResponse.json({ ok: true });
}
