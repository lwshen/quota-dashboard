import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { ENV } from "@/lib/env";
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Constant-time comparison; hash to equal-length digests first to avoid leaking length.
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function POST(req: Request) {
  if (ENV.authDisabled) return NextResponse.json({ error: "auth disabled" }, { status: 400 });
  if (!ENV.dashboardPassword) return NextResponse.json({ error: "server auth not configured" }, { status: 503 });

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const password = body.password ?? "";
  if (!password || !safeEqual(password, ENV.dashboardPassword)) {
    return NextResponse.json({ error: "密码错误" }, { status: 401 });
  }

  const { token, maxAge } = await createSessionToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  });
  return res;
}
