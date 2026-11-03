export interface CredentialFieldMeta {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderMeta {
  provider: string;
  label: string;
  enabled: boolean;
  credentialFields: CredentialFieldMeta[];
}

export interface CredentialMeta {
  provider: string;
  configuredKeys: string[];
  updatedAt: string;
  fetchedAt: string | null;
  fetchError: string | null;
}

export interface CredentialDraft {
  fields: Record<string, string>;
  action: "update" | "replace";
  clearFields: string[];
  confirmSameAccount: boolean;
}

export function emptyDraft(configured: boolean): CredentialDraft {
  return { fields: {}, action: configured ? "update" : "replace", clearFields: [], confirmSameAccount: false };
}

export function credentialStatus(credential?: CredentialMeta) {
  if (!credential) return { label: "待配置", tone: "muted" };
  if (credential.fetchError) return { label: "获取失败", tone: "error" };
  if (credential.fetchedAt) return { label: "已获取用量", tone: "success" };
  return { label: "待获取用量", tone: "muted" };
}

export function hasDraftChanges(draft?: CredentialDraft) {
  return !!draft && (Object.values(draft.fields).some((value) => value.trim()) || draft.clearFields.length > 0);
}
