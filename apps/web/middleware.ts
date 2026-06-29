import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ENV } from "./lib/env";
import { SESSION_COOKIE, verifySessionToken } from "./lib/auth";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

const hits = new Map<string, { count: number; reset: number }>();
function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const e = hits.get(key);
  if (!e || e.reset < now) {
    hits.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  e.count++;
  return e.count <= limit;
}

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  return xff ? (xff.split(",")[0] ?? "").trim() || "unknown" : "unknown";
}

// Skip auth but still rate-limited.
const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/logout"]);

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const ip = clientIp(req);

  const isLogin = pathname === "/api/login" || pathname === "/login";
  const allowed = isLogin ? rateLimit(`login:${ip}`, 10, 10 * 60_000) : rateLimit(`gen:${ip}`, 240, 60_000);
  if (!allowed) {
    return NextResponse.json({ error: "too many requests" }, { status: 429, headers: { "retry-after": "60" } });
  }

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  if (ENV.authDisabled) return NextResponse.next();

  // Fail-closed: no password set means an unprotected deployment, so block everything.
  if (!ENV.dashboardPassword) {
    const msg = "DASHBOARD_PASSWORD 未设置：鉴权未配置，已拒绝访问。请配置后重启（本地开发可设 AUTH_DISABLED=true）。";
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: msg }, { status: 503 });
    return new NextResponse(msg, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const valid = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (valid) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}
