import type { Database } from './sqlite.js'

export const applySchemaVersion54 = (db: Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_step_attempts (
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt > 0),
    dispatch_id TEXT REFERENCES dispatches(id) ON DELETE SET NULL,
    snapshot TEXT NOT NULL, invalidated_at INTEGER, reason TEXT,
    PRIMARY KEY(run_id, step_id, attempt)
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_attempt_dispatch ON workflow_step_attempts(dispatch_id);`)
}
