import { extractAntigravityJwtClaims, parseIsoOrUnix } from "@quota/core";

export const MAX_CREDENTIAL_IMPORT_BYTES = 1024 * 1024;

export type JsonCredentialProvider = "codex" | "codex2" | "claude" | "antigravity";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function readText(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (value == null) continue;
    if (typeof value !== "string") throw new Error(`${key} 必须是字符串`);
    if (value.trim()) return value.trim();
  }
  return "";
}

function readExpiry(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (value == null || value === "") continue;
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`${key} 必须是字符串或时间戳数字`);
    }
    const iso = parseIsoOrUnix(value);
    if (!iso) throw new Error(`${key} 过期时间格式不正确`);
    return iso;
  }
  return "";
}

function parseAntigravityJson(root: Record<string, unknown>): Record<string, string> {
  const tokens = Object.hasOwn(root, "token") ? record(root.token) : root;
  if (!tokens) throw new Error("token 必须是一个凭据对象");
  const bearerToken = readText(tokens, ["access_token", "accessToken", "bearerToken"]);
  if (!bearerToken) {
    throw new Error("未找到 Access Token，请导入 Antigravity oauth_creds.json 或包含 access_token 的 JSON");
  }
  const refreshToken = readText(tokens, ["refresh_token", "refreshToken"]);
  const clientSecret = readText(root, ["client_secret", "clientSecret"]);
  const clientId = readText(root, ["client_id", "clientId"]);
  const projectId = readText(root, ["project_id", "projectId"]);
  const idToken = readText(root, ["id_token", "idToken"])
    || (tokens !== root ? readText(tokens, ["id_token", "idToken"]) : "");
  const email = readText(root, ["email"]) || extractAntigravityJwtClaims(idToken).email || "";
  const expiresAt = readExpiry(tokens, ["expiry_date", "expiryDate", "expiresAt", "expires_at", "expiry"])
    || (tokens !== root ? readExpiry(root, ["expiry_date", "expiryDate", "expiresAt", "expires_at", "expiry"]) : "");

  return {
    bearerToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(clientSecret ? { "extra.clientSecret": clientSecret } : {}),
    ...(clientId ? { "extra.clientId": clientId } : {}),
    ...(projectId ? { "extra.projectId": projectId } : {}),
    ...(email ? { "extra.email": email } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

// Runs in the browser. Only supported form fields leave this parser; unrelated
// API keys, ID tokens, MCP credentials, and metadata are never imported.
export function parseCredentialJson(provider: JsonCredentialProvider, source: string): Record<string, string> {
  if (new TextEncoder().encode(source).byteLength > MAX_CREDENTIAL_IMPORT_BYTES) {
    throw new Error("JSON 内容过大，请使用不超过 1 MB 的凭据文件或字符串");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(source.replace(/^\uFEFF/, "")); }
  catch { throw new Error("无法解析 JSON，请检查内容格式后重试"); }
  const root = record(parsed);
  if (!root) throw new Error("凭据 JSON 必须是一个对象");

  if (provider === "antigravity") return parseAntigravityJson(root);

  const codex = provider !== "claude";
  const wrapper = codex ? "tokens" : "claudeAiOauth";
  const tokens = Object.hasOwn(root, wrapper) ? record(root[wrapper]) : root;
  if (!tokens) throw new Error(`${wrapper} 必须是一个凭据对象`);
  const bearerToken = readText(tokens, codex ? ["access_token", "bearerToken", "accessToken"] : ["accessToken", "bearerToken", "access_token"]);
  if (!bearerToken) {
    throw new Error(codex
      ? "未找到 Access Token，请导入 Codex auth.json 或包含 access_token 的 JSON"
      : "未找到 Access Token，请导入 Claude Code .credentials.json 或包含 accessToken 的 JSON");
  }
  const refreshToken = readText(tokens, codex ? ["refresh_token", "refreshToken"] : ["refreshToken", "refresh_token"]);
  const accountId = codex ? readText(tokens, ["account_id", "accountId"]) || (tokens !== root ? readText(root, ["account_id", "accountId"]) : "") : "";
  return {
    bearerToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(accountId ? { accountId } : {}),
  };
}
