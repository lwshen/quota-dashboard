import { db } from "./db";

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
