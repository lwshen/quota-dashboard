import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ENV } from "@/runtime/env";

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(ENV.dbPath), { recursive: true });
  const d = new Database(ENV.dbPath);
  d.pragma("journal_mode = WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id         TEXT PRIMARY KEY,
      provider   TEXT NOT NULL,
      alias      TEXT NOT NULL,
      group_name TEXT NOT NULL DEFAULT '',
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_settings (
      provider   TEXT PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS credentials (
      provider   TEXT PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 1,
      mode       TEXT NOT NULL DEFAULT 'auto',
      data       TEXT NOT NULL,            -- Encrypted JSON(ProviderCredentials)
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      provider   TEXT PRIMARY KEY,
      snapshot   TEXT,                     -- JSON(UsageSnapshot) or NULL
      error      TEXT,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshot_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      provider   TEXT NOT NULL,
      snapshot   TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_provider ON snapshot_history(provider, fetched_at);
    CREATE TABLE IF NOT EXISTS notification_alert_state (
      provider  TEXT NOT NULL,
      alert_key TEXT NOT NULL,
      state     TEXT NOT NULL,
      PRIMARY KEY (provider, alert_key)
    );
  `);
  // Retain legacy storage keys and encrypted bytes; codex2 becomes an ordinary Codex account.
  d.transaction(() => {
    d.exec(`INSERT OR IGNORE INTO accounts (id, provider, alias, group_name, enabled, created_at)
      SELECT legacy.provider, CASE WHEN legacy.provider='codex2' THEN 'codex' ELSE legacy.provider END,
        CASE legacy.provider WHEN 'codex' THEN 'Codex' WHEN 'codex2' THEN 'Codex #2'
          WHEN 'claude' THEN 'Claude' WHEN 'grok' THEN 'Grok' WHEN 'kimi' THEN 'Kimi'
          WHEN 'moonshot' THEN 'Moonshot' ELSE 'RightAPI' END,
        '', COALESCE(settings.enabled, 1) * COALESCE(creds.enabled, 1),
        COALESCE(creds.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      FROM (SELECT provider FROM credentials UNION SELECT provider FROM provider_settings
        UNION SELECT provider FROM snapshots UNION SELECT provider FROM snapshot_history
        UNION SELECT provider FROM notification_alert_state) legacy
      LEFT JOIN provider_settings settings ON settings.provider=legacy.provider
      LEFT JOIN credentials creds ON creds.provider=legacy.provider
      WHERE legacy.provider IN ('codex','codex2','claude','grok','kimi','moonshot','rightapi')`);
  })();
  _db = d;
  return d;
}
