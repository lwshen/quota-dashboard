import type { AccountMeta } from "@/shared/provider-management";
import { randomUUID } from "node:crypto";
import { getDescriptor, isProvider, type UsageProvider } from "@quota/core";
import { db } from "./db";
import { clearAlertState } from "./alert-state";
import { clearUsageData } from "./cleanup";

export type Account = AccountMeta;

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
export function ensureLegacyAccount(id: string): void {
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
    clearUsageData(id);
    db().prepare(`DELETE FROM credentials WHERE provider=?`).run(id);
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
