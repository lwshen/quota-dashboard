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
