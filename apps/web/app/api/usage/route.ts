import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { listDescriptors } from "@quota/core";
import { listSnapshots } from "@/lib/store";
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
      // `identity` (balance/email/org) and `providerCost` (dollar spend / credit balance)
      // are account-billing data — admin-only, stripped for anonymous callers.
      if (!authed) snapshot = { ...snapshot, identity: undefined, providerCost: undefined };
    }
    return {
      provider: d.provider,
      label: d.label,
      accentColor: d.accentColor ?? null,
      producesRateWindows: d.producesRateWindows,
      snapshot,
      error: s?.error ?? null,
      fetchedAt: s?.fetchedAt ?? null,
    };
  });
  return NextResponse.json({ providers });
}
