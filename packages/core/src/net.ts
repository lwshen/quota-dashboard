// SSRF: literal-level checks only; DNS-resolution checks live in apps/web/lib/ssrf.ts
// to stop public domains resolving to private addresses.

export function isPrivateIpLiteral(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "" || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255)) return true; // malformed -> fail closed
    const [a, b] = o as [number, number, number, number];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true; // 169.254.169.254 = cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64.0.0/10)
    return false;
  }

  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true;
    if (h.startsWith("::ffff:")) return isPrivateIpLiteral(h.slice(7));
    return false;
  }

  return false; // ordinary domain -> defer to DNS-layer check
}

export function assertSafeExternalUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (u.protocol !== "https:") throw new Error("只允许 https:// URL");
  if (u.username || u.password) throw new Error("URL 不得包含用户名/密码");
  if (isPrivateIpLiteral(u.hostname)) throw new Error("不允许私有 / 回环 / link-local 主机");
}
