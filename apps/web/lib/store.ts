import { randomUUID } from "node:crypto";
import { getDescriptor, isProvider, type ProviderCredentials, type SourceMode, type UsageProvider, type UsageSnapshot } from "@quota/core";
import { db } from "./db";
import { decrypt, encrypt } from "./crypto";

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

export interface Account {
  id: string;
  provider: UsageProvider;
  alias: string;
  groupName: string;
  enabled: boolean;
  createdAt: string;
}

export function listAccounts(): Account[] {
  const rows = db().prepare(`SELECT id, provider, alias, group_name AS groupName, enabled, created_at AS createdAt
    FROM accounts ORDER BY group_name COLLATE NOCASE, created_at, id`).all() as (Omit<Account, "enabled"> & { enabled: number })[];
  return rows.map((row) => ({ ...row, enabled: !!row.enabled }));
}

export function getAccount(id: string): Account | null {
  const row = db().prepare(`SELECT id, provider, alias, group_name AS groupName, enabled, created_at AS createdAt FROM accounts WHERE id=?`)
    .get(id) as (Omit<Account, "enabled"> & { enabled: number }) | undefined;
  return row ? { ...row, enabled: !!row.enabled } : null;
}

export function createAccount(provider: UsageProvider, alias: string, groupName = "", now = new Date()): Account {
  const id = randomUUID();
  db().prepare(`INSERT INTO accounts (id, provider, alias, group_name, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, provider === "codex2" ? "codex" : provider, alias, groupName, now.toISOString());
  return getAccount(id)!;
}

// Compatibility for pre-account API clients and legacy storage callers, never for the new account form.
function ensureLegacyAccount(id: string): void {
  if (getAccount(id)) return;
  if (!isProvider(id)) throw new Error("账号不存在");
  db().prepare(`INSERT INTO accounts (id, provider, alias, created_at) VALUES (?, ?, ?, ?)`)
    .run(id, id === "codex2" ? "codex" : id, getDescriptor(id).label.split(" (")[0], new Date().toISOString());
}

export function updateAccount(id: string, fields: { alias?: string; groupName?: string; enabled?: boolean }): void {
  db().transaction(() => {
    if (fields.alias !== undefined) db().prepare(`UPDATE accounts SET alias=? WHERE id=?`).run(fields.alias, id);
    if (fields.groupName !== undefined) db().prepare(`UPDATE accounts SET group_name=? WHERE id=?`).run(fields.groupName, id);
    if (fields.enabled !== undefined) setProviderEnabled(id, fields.enabled);
  })();
}

export function deleteAccount(id: string): void {
  db().transaction(() => {
    deleteCredential(id);
    db().prepare(`DELETE FROM provider_settings WHERE provider=?`).run(id);
    db().prepare(`DELETE FROM accounts WHERE id=?`).run(id);
  })();
}

export function listProviderSettings(): Map<string, boolean> {
  const rows = db().prepare(`SELECT id AS provider, enabled FROM accounts`).all() as { provider: string; enabled: number }[];
  return new Map(rows.map((r) => [r.provider, !!r.enabled]));
}

export function setProviderEnabled(provider: string, enabled: boolean): void {
  ensureLegacyAccount(provider);
  db().prepare(`UPDATE accounts SET enabled=? WHERE id=?`).run(Number(enabled), provider);
  db().prepare(`INSERT INTO provider_settings (provider, enabled) VALUES (?, ?)
    ON CONFLICT(provider) DO UPDATE SET enabled=excluded.enabled`).run(provider, Number(enabled));
  if (!enabled) clearAlertState(provider);
}

// A separate setting also covers providers that have no credentials yet.
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
  db().prepare(`DELETE FROM snapshot_history WHERE provider=?`).run(provider);
  db().prepare(`DELETE FROM snapshots WHERE provider=?`).run(provider);
  clearAlertState(provider);
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
  db().prepare(`DELETE FROM snapshots WHERE provider=?`).run(provider);
  db().prepare(`DELETE FROM snapshot_history WHERE provider=?`).run(provider);
  clearAlertState(provider);
}

export function getAlertState<T>(provider: string, key: string): T | null {
  const row = db().prepare(`SELECT state FROM notification_alert_state WHERE provider=? AND alert_key=?`)
    .get(provider, key) as { state: string } | undefined;
  return row ? JSON.parse(row.state) as T : null;
}

export function saveAlertState(provider: string, key: string, state: unknown): void {
  db().prepare(`INSERT INTO notification_alert_state (provider, alert_key, state) VALUES (?, ?, ?)
    ON CONFLICT(provider, alert_key) DO UPDATE SET state=excluded.state`).run(provider, key, JSON.stringify(state));
}

export function clearAlertState(provider: string, key?: string): void {
  if (key) db().prepare(`DELETE FROM notification_alert_state WHERE provider=? AND alert_key=?`).run(provider, key);
  else db().prepare(`DELETE FROM notification_alert_state WHERE provider=?`).run(provider);
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

export function saveSnapshot(provider: string, snapshot: UsageSnapshot | null, error: string | null, now: Date): void {
  ensureLegacyAccount(provider);
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
  provider: string;
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
    provider: r.provider,
    snapshot: r.snapshot ? normalizeSnapshot(JSON.parse(r.snapshot) as UsageSnapshot) : null,
    error: r.error,
    fetchedAt: r.fetched_at,
  }));
}

function normalizeSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  return snapshot.provider === "codex2" ? { ...snapshot, provider: "codex" } : snapshot;
}

export function historyFor(provider: string, limit = 200): { snapshot: UsageSnapshot; fetchedAt: string }[] {
  // Order by id (save order), not fetched_at: fetched_at is stamped at fetch start, so
  // overlapping fetches can persist out of chronological order and ties are unordered.
  const rows = db()
    .prepare(`SELECT snapshot, fetched_at FROM snapshot_history WHERE provider=? ORDER BY id DESC LIMIT ?`)
    .all(provider, limit) as { snapshot: string; fetched_at: string }[];
  return rows.reverse().map((r) => ({ snapshot: normalizeSnapshot(JSON.parse(r.snapshot) as UsageSnapshot), fetchedAt: r.fetched_at }));
}

export function* historyInRange(provider: string, from: Date, to: Date): Generator<{ snapshot: UsageSnapshot; fetchedAt: string }> {
  // Stream indexed rows so a long range never loads every raw upstream response into memory.
  const rows = db().prepare(`SELECT snapshot, fetched_at FROM snapshot_history
    WHERE provider=? AND fetched_at>=? AND fetched_at<=? ORDER BY fetched_at ASC, id ASC`)
    .iterate(provider, from.toISOString(), to.toISOString());
  for (const row of rows) {
    const r = row as { snapshot: string; fetched_at: string };
    yield { snapshot: normalizeSnapshot(JSON.parse(r.snapshot) as UsageSnapshot), fetchedAt: r.fetched_at };
  }
}
