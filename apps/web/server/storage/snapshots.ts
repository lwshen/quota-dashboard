import type { UsageSnapshot } from "@quota/core";
import { db } from "./db";
import { ensureLegacyAccount } from "./accounts";

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
