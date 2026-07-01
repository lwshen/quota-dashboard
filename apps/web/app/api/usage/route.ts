import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { listDescriptors } from "@quota/core";
import { listSnapshots } from "@/lib/store";
import { fileSourceFor } from "@/lib/extCreds";
import { ENV } from "@/lib/env";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // This endpoint is public, so anonymous callers get usage windows but not account
  // identity (which can hold balance / email / org). Authed admins get the full view.
  const authed = ENV.authDisabled || (await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value));
  const snaps = new Map(listSnapshots().map((s) => [s.provider, s]));
  const providers = listDescriptors().map((d) => {
    const s = snaps.get(d.provider);
    let snapshot = null;
    if (s?.snapshot) {
      // `extra` holds the raw upstream response; drop it so only UI fields are exposed.
      snapshot = { ...s.snapshot, extra: undefined };
      // `identity` can carry account balance / email / org — admin-only.
      if (!authed) snapshot = { ...snapshot, identity: undefined };
    }
    // A file source is managed by config (read fresh from disk); the UI shows a badge instead of
    // the edit affordance. Only the booleans are exposed — never the path.
    const fileSrc = fileSourceFor(d.provider);
    return {
      provider: d.provider,
      label: d.label,
      producesRateWindows: d.producesRateWindows,
      snapshot,
      error: s?.error ?? null,
      fetchedAt: s?.fetchedAt ?? null,
      external: !!fileSrc,
      externalWritable: !!fileSrc?.writable,
    };
  });
  return NextResponse.json({ providers });
}
