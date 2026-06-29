import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ENV } from "./env";

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(ENV.dbPath), { recursive: true });
  const d = new Database(ENV.dbPath);
  d.pragma("journal_mode = WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      provider   TEXT PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 1,
      mode       TEXT NOT NULL DEFAULT 'auto',
      data       TEXT NOT NULL,            -- 加密后的 JSON(ProviderCredentials)
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      provider   TEXT PRIMARY KEY,
      snapshot   TEXT,                     -- JSON(UsageSnapshot) 或 NULL
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
  `);
  _db = d;
  return d;
}
