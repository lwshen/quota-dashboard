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

// Public read surface (no auth): the read-only dashboard view, the endpoints that
// power it, and the auth flow. Everything else is an admin / mutating operation and
// requires a valid session (default-deny). Rate limiting still applies to all paths.
const PUBLIC_GET = new Set(["/", "/login", "/api/usage", "/api/providers", "/api/session"]);
const PUBLIC_POST = new Set(["/api/login", "/api/logout"]);

function isPublic(pathname: string, method: string): boolean {
  if (method === "GET" || method === "HEAD") return PUBLIC_GET.has(pathname);
  if (method === "POST") return PUBLIC_POST.has(pathname);
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const ip = clientIp(req);

  // Only the actual password submission counts against the strict brute-force limit;
  // loading the /login page (and any other read) uses the lenient general bucket.
  const isLoginAttempt = pathname === "/api/login" && req.method === "POST";
  const allowed = isLoginAttempt
    ? rateLimit(`login:${ip}`, 10, 10 * 60_000)
    : rateLimit(`gen:${ip}`, 240, 60_000);
  if (!allowed) {
    return NextResponse.json({ error: "too many requests" }, { status: 429, headers: { "retry-after": "60" } });
  }

  if (isPublic(pathname, req.method)) return NextResponse.next();

  // From here on the request targets an admin / mutating operation.
  if (ENV.authDisabled) return NextResponse.next();

  // Fail-closed: without a password the admin surface can never be unlocked, so refuse
  // it. The public read surface above is unaffected, so the dashboard stays viewable.
  if (!ENV.dashboardPassword) {
    const msg = "DASHBOARD_PASSWORD 未设置：管理操作已被拒绝，无法添加 / 修改配置。请配置后重启（本地开发可设 AUTH_DISABLED=true）。";
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
