import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ENV } from "@/runtime/env";
import { SESSION_COOKIE, verifySessionToken } from "@/runtime/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public: lets the dashboard decide whether to show admin controls. Reveals only
// a boolean, never the session token or any secret.
export async function GET() {
  if (ENV.authDisabled) return NextResponse.json({ authed: true });
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return NextResponse.json({ authed: await verifySessionToken(token) });
}
