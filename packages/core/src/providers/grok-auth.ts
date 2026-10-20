import type { ProviderCredentials } from "../adapter";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function claims(token: string | undefined): Record<string, unknown> {
  try {
    const part = token?.trim().replace(/^Bearer\s+/i, "").split(".")[1];
    if (!part) return {};
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// Unverified claims are only scheduling/principal hints; the upstream validates the token.
export function grokTokenExpiresAt(token: string | undefined): string | null {
  const exp = claims(token).exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
  const date = new Date(exp * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeGrokCredentials(input: ProviderCredentials): ProviderCredentials {
  const bearerToken = text(input.bearerToken).replace(/^Bearer(?:\s+|$)/i, "").trim();
  if (!bearerToken || /^(xai-|cookie:)/i.test(bearerToken) || /[=\s]/.test(bearerToken)) {
    throw new Error("请填写 grok login 生成的 Access Token（不是 xai- API Key 或 Cookie）");
  }
  const refreshToken = text(input.refreshToken);
  const clientId = text(input.extra?.clientId);
  if (refreshToken && !clientId) throw new Error("自动续期需要 Client ID，请从 auth.json 导入或填写 oidc_client_id");
  if (/\s/.test(clientId)) throw new Error("Grok Client ID 格式不正确");
  const suppliedExpiry = text(input.expiresAt);
  if (suppliedExpiry && !Number.isFinite(Date.parse(suppliedExpiry))) throw new Error("Grok 过期时间格式不正确");
  const jwtExpiry = grokTokenExpiresAt(bearerToken);
  const expiries = [suppliedExpiry, jwtExpiry].filter((s): s is string => !!s).map((s) => Date.parse(s));
  const tokenClaims = claims(bearerToken);
  const principalType = text(tokenClaims.principal_type ?? tokenClaims.principalType);
  const principalId = text(tokenClaims.principal_id ?? tokenClaims.principalId);
  return {
    bearerToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: expiries.length ? new Date(Math.min(...expiries)).toISOString() : null,
    extra: { ...(clientId ? { clientId } : {}), ...(principalType ? { principalType } : {}), ...(principalId ? { principalId } : {}) },
  };
}

export interface GrokAuthImport {
  scope: string;
  label: string;
  fields: Record<string, string>;
}

export function parseGrokAuthFile(source: string): GrokAuthImport[] {
  let root: unknown;
  try { root = JSON.parse(source); } catch { throw new Error("无法解析 Grok auth.json，请选择有效的 JSON 文件"); }
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("Grok auth.json 格式不正确");
  const accounts: GrokAuthImport[] = [];
  for (const [scope, entry] of Object.entries(root)) {
    if (!scope.startsWith("https://auth.x.ai::") || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!text(record.key)) continue;
    const issuer = text(record.oidc_issuer).replace(/\/$/, "");
    if (issuer && issuer !== "https://auth.x.ai") throw new Error("当前仅支持 auth.x.ai 签发的 Grok 登录凭据");
    const creds = normalizeGrokCredentials({
      bearerToken: text(record.key), refreshToken: text(record.refresh_token), expiresAt: text(record.expires_at),
      extra: { clientId: text(record.oidc_client_id) || scope.slice("https://auth.x.ai::".length) },
    });
    accounts.push({
      scope, label: text(record.email) || scope,
      fields: {
        bearerToken: creds.bearerToken!, refreshToken: creds.refreshToken ?? "",
        "extra.clientId": creds.extra?.clientId ?? "", expiresAt: creds.expiresAt ?? "",
      },
    });
  }
  if (!accounts.length) throw new Error("未找到 auth.x.ai 登录凭据，请先运行 grok login");
  return accounts.sort((a, b) => a.scope.localeCompare(b.scope));
}
