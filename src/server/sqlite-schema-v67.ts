import type { Database } from './sqlite.js'

export const applySchemaVersion67 = (db: Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS clarification_requests (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    requested_by TEXT NOT NULL,
    text TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    created_worker INTEGER NOT NULL,
    dispatch_id TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_clarification_pending_worker
    ON clarification_requests(workspace_id,worker_id) WHERE dispatch_id IS NULL;`)
}
