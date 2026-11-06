import type { ProviderCredentials, SourceMode, UsageProvider } from "@quota/core";
import { decrypt, encrypt } from "@/server/security/crypto";
import { db } from "./db";
import { ensureLegacyAccount } from "./accounts";
import { clearUsageData } from "./cleanup";

export interface StoredCredential {
  accountId: string;
  provider: UsageProvider;
  enabled: boolean;
  mode: SourceMode;
  credentials: ProviderCredentials;
  updatedAt: string;
  revision: string;
}

interface CredentialRow {
  account_id: string;
  provider: string;
  enabled: number;
  mode: string;
  data: string;
  updated_at: string;
}

const credentialSelect = `SELECT c.provider AS account_id, a.provider, a.enabled,
  c.mode, c.data, c.updated_at FROM credentials c
  JOIN accounts a ON a.id=c.provider`;

function rowToCredential(r: CredentialRow): StoredCredential {
  return {
    accountId: r.account_id,
    provider: r.provider as UsageProvider,
    enabled: !!r.enabled,
    mode: r.mode as SourceMode,
    credentials: JSON.parse(decrypt(r.data)) as ProviderCredentials,
    updatedAt: r.updated_at,
    revision: r.data,
  };
}

export function saveCredential(provider: string, mode: SourceMode, creds: ProviderCredentials, now: Date): void {
  ensureLegacyAccount(provider);
  db()
    .prepare(
      `INSERT INTO credentials (provider, enabled, mode, data, updated_at)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         mode=excluded.mode, data=excluded.data, updated_at=excluded.updated_at, enabled=1`,
    )
    .run(provider, mode, encrypt(JSON.stringify(creds)), now.toISOString());
  // Never show or compare a previous account's usage after replacement.
  clearUsageData(provider);
}

export function updateCredentialSecret(provider: string, creds: ProviderCredentials, now: Date, revision: string): string | null {
  const data = encrypt(JSON.stringify(creds));
  const result = db()
    .prepare(`UPDATE credentials SET data=?, updated_at=? WHERE provider=? AND data=?`)
    .run(data, now.toISOString(), provider, revision);
  return result.changes === 1 ? data : null;
}

export function deleteCredential(provider: string): void {
  db().prepare(`DELETE FROM credentials WHERE provider=?`).run(provider);
  clearUsageData(provider);
}

export function listCredentials(): StoredCredential[] {
  const rows = db().prepare(credentialSelect).all() as CredentialRow[];
  return rows.map(rowToCredential);
}

export function getCredential(provider: string): StoredCredential | null {
  const r = db()
    .prepare(`${credentialSelect} WHERE c.provider=?`)
    .get(provider) as CredentialRow | undefined;
  return r ? rowToCredential(r) : null;
}
