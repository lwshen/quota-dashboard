import type { CredentialField, UsageProvider } from "@quota/core";

export type CredentialFieldMeta = CredentialField;

export interface ProviderMeta {
  provider: string;
  label: string;
  enabled: boolean;
  credentialFields: CredentialFieldMeta[];
}

export interface CredentialMeta {
  accountId?: string;
  provider: string;
  configuredKeys: string[];
  updatedAt: string;
  fetchedAt: string | null;
  fetchError: string | null;
}

export interface AccountMeta {
  id: string;
  provider: UsageProvider;
  alias: string;
  groupName: string;
  enabled: boolean;
  createdAt: string;
}

export function credentialStatus(credential?: CredentialMeta) {
  if (!credential) return { label: "待配置", tone: "muted" };
  if (credential.fetchError) return { label: "获取失败", tone: "error" };
  if (credential.fetchedAt) return { label: "已获取用量", tone: "success" };
  return { label: "待获取用量", tone: "muted" };
}
