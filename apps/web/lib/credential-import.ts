export const MAX_CREDENTIAL_IMPORT_BYTES = 1024 * 1024;

export type JsonCredentialProvider = "codex" | "codex2" | "claude";

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
