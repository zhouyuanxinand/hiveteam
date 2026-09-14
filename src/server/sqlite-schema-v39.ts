import type { Database } from 'better-sqlite3'

export const applySchemaVersion39 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_verifications (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
      report_revision INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      command TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'cancelled', 'interrupted')),
      output TEXT NOT NULL DEFAULT '',
      output_truncated INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER,
      error TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      accepted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_verifications_dispatch
      ON dispatch_verifications(workspace_id, dispatch_id, started_at DESC);
  `)
}
