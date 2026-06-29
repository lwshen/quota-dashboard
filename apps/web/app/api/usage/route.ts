import { NextResponse } from "next/server";
import { listDescriptors } from "@quota/core";
import { listSnapshots } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const snaps = new Map(listSnapshots().map((s) => [s.provider, s]));
  const providers = listDescriptors().map((d) => {
    const s = snaps.get(d.provider);
    // `extra` holds the raw upstream response; drop it so only UI fields are exposed.
    const snapshot = s?.snapshot ? { ...s.snapshot, extra: undefined } : null;
    return {
      provider: d.provider,
      label: d.label,
      producesRateWindows: d.producesRateWindows,
      snapshot,
      error: s?.error ?? null,
      fetchedAt: s?.fetchedAt ?? null,
    };
  });
  return NextResponse.json({ providers });
}
