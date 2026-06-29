import type { ProviderCredentials, SourceMode, UsageProvider, UsageSnapshot } from "@quota/core";
import { db } from "./db";
import { decrypt, encrypt } from "./crypto";

export interface StoredCredential {
  provider: UsageProvider;
  enabled: boolean;
  mode: SourceMode;
  credentials: ProviderCredentials;
  updatedAt: string;
}

interface CredentialRow {
  provider: string;
  enabled: number;
  mode: string;
  data: string;
  updated_at: string;
}

function rowToCredential(r: CredentialRow): StoredCredential {
  return {
    provider: r.provider as UsageProvider,
    enabled: !!r.enabled,
    mode: r.mode as SourceMode,
    credentials: JSON.parse(decrypt(r.data)) as ProviderCredentials,
    updatedAt: r.updated_at,
  };
}

export function saveCredential(provider: UsageProvider, mode: SourceMode, creds: ProviderCredentials, now: Date): void {
  db()
    .prepare(
      `INSERT INTO credentials (provider, enabled, mode, data, updated_at)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         mode=excluded.mode, data=excluded.data, updated_at=excluded.updated_at, enabled=1`,
    )
    .run(provider, mode, encrypt(JSON.stringify(creds)), now.toISOString());
}

export function updateCredentialSecret(provider: UsageProvider, creds: ProviderCredentials, now: Date): void {
  db()
    .prepare(`UPDATE credentials SET data=?, updated_at=? WHERE provider=?`)
    .run(encrypt(JSON.stringify(creds)), now.toISOString(), provider);
}

export function deleteCredential(provider: UsageProvider): void {
  db().prepare(`DELETE FROM credentials WHERE provider=?`).run(provider);
  db().prepare(`DELETE FROM snapshots WHERE provider=?`).run(provider);
}

export function listCredentials(): StoredCredential[] {
  const rows = db().prepare(`SELECT provider, enabled, mode, data, updated_at FROM credentials`).all() as CredentialRow[];
  return rows.map(rowToCredential);
}

export function getCredential(provider: UsageProvider): StoredCredential | null {
  const r = db()
    .prepare(`SELECT provider, enabled, mode, data, updated_at FROM credentials WHERE provider=?`)
    .get(provider) as CredentialRow | undefined;
  return r ? rowToCredential(r) : null;
}

export function saveSnapshot(provider: UsageProvider, snapshot: UsageSnapshot | null, error: string | null, now: Date): void {
  db()
    .prepare(
      `INSERT INTO snapshots (provider, snapshot, error, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         snapshot=excluded.snapshot, error=excluded.error, fetched_at=excluded.fetched_at`,
    )
    .run(provider, snapshot ? JSON.stringify(snapshot) : null, error, now.toISOString());
  if (snapshot) {
    db()
      .prepare(`INSERT INTO snapshot_history (provider, snapshot, fetched_at) VALUES (?, ?, ?)`)
      .run(provider, JSON.stringify(snapshot), now.toISOString());
  }
}

export interface SnapshotRow {
  provider: UsageProvider;
  snapshot: UsageSnapshot | null;
  error: string | null;
  fetchedAt: string;
}

interface RawSnapshotRow {
  provider: string;
  snapshot: string | null;
  error: string | null;
  fetched_at: string;
}

export function listSnapshots(): SnapshotRow[] {
  const rows = db().prepare(`SELECT provider, snapshot, error, fetched_at FROM snapshots`).all() as RawSnapshotRow[];
  return rows.map((r) => ({
    provider: r.provider as UsageProvider,
    snapshot: r.snapshot ? (JSON.parse(r.snapshot) as UsageSnapshot) : null,
    error: r.error,
    fetchedAt: r.fetched_at,
  }));
}

export function historyFor(provider: UsageProvider, limit = 200): { snapshot: UsageSnapshot; fetchedAt: string }[] {
  const rows = db()
    .prepare(`SELECT snapshot, fetched_at FROM snapshot_history WHERE provider=? ORDER BY fetched_at DESC LIMIT ?`)
    .all(provider, limit) as { snapshot: string; fetched_at: string }[];
  return rows.reverse().map((r) => ({ snapshot: JSON.parse(r.snapshot) as UsageSnapshot, fetchedAt: r.fetched_at }));
}
