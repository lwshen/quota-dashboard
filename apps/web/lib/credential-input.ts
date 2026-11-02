import type { ProviderCredentials, ProviderDescriptor } from "@quota/core";

export class CredentialInputError extends Error {
  constructor(message: string, public fieldErrors: Record<string, string> = {}) {
    super(message);
  }
}

export function prepareCredentialInput(
  descriptor: ProviderDescriptor,
  fields: Record<string, unknown>,
  options: { action: "update" | "replace"; existing?: ProviderCredentials; clearFields: string[]; confirmSameAccount: boolean },
): ProviderCredentials {
  const updating = options.action === "update";
  if (updating && !options.existing) throw new CredentialInputError("尚未配置凭据，请先添加凭据");
  const credentials: ProviderCredentials = updating ? { ...options.existing, extra: { ...options.existing?.extra } } : {};
  const allowed = new Map<string, ProviderDescriptor["credentialFields"][number]>(descriptor.credentialFields.map((f) => [f.key, f]));
  const errors: Record<string, string> = {};
  const get = (creds: ProviderCredentials, key: string) => key.startsWith("extra.")
    ? creds.extra?.[key.slice(6)] : (creds as Record<string, unknown>)[key];
  const put = (key: string, value?: string) => {
    const target = key.startsWith("extra.") ? (credentials.extra ??= {}) : credentials as Record<string, unknown>;
    const name = key.startsWith("extra.") ? key.slice(6) : key;
    if (value === undefined) delete target[name];
    else target[name] = value;
  };

  for (const key of options.clearFields) {
    const field = allowed.get(key);
    if (!updating || !field || field.required) throw new CredentialInputError("仅能在更新时清除可选字段");
    if (typeof fields[key] === "string" && fields[key].trim()) throw new CredentialInputError("不能同时填写和清除同一字段");
    put(key);
  }
  let authenticationChanged = false;
  for (const field of descriptor.credentialFields) {
    const raw = fields[field.key];
    if (raw != null && typeof raw !== "string") {
      errors[field.key] = "请填写文本";
      continue;
    }
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) {
      const old = options.existing && get(options.existing, field.key);
      if (updating && old && value !== old && (field.key === "accountId" || field.key === "extra.clientId")) {
        errors[field.key] = "账户标识已改变，请使用「替换整套凭据」";
      }
      if (field.secret && value !== old) authenticationChanged = true;
      put(field.key, value);
    }
    if (field.required && !get(credentials, field.key)) errors[field.key] = `请填写 ${field.label}`;
  }
  if (Object.keys(errors).length) throw new CredentialInputError("请检查标出的字段", errors);
  if (updating && authenticationChanged && !options.confirmSameAccount) {
    throw new CredentialInputError("更新 Token 前，请确认它们属于同一账户；切换账户请替换整套凭据");
  }
  if (authenticationChanged) {
    delete credentials.refreshState;
    // A replacement access token must not inherit the previous token's expiry.
    if (typeof fields.bearerToken === "string" && fields.bearerToken.trim() && !fields.expiresAt) delete credentials.expiresAt;
  }
  if (options.clearFields.includes("refreshToken")) delete credentials.refreshState;
  if (credentials.extra && !Object.keys(credentials.extra).length) delete credentials.extra;
  return credentials;
}
