import { db } from "./db";
import { clearAlertState } from "./alert-state";

export function clearUsageData(accountId: string): void {
  db().prepare(`DELETE FROM snapshots WHERE provider=?`).run(accountId);
  db().prepare(`DELETE FROM snapshot_history WHERE provider=?`).run(accountId);
  clearAlertState(accountId);
}
