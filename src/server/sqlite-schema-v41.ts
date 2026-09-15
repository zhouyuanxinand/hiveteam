import type { Database } from 'better-sqlite3'

export const applySchemaVersion41 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_pull_requests (
      dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      verification_id TEXT NOT NULL REFERENCES dispatch_verifications(id) ON DELETE CASCADE,
      head_sha TEXT NOT NULL,
      repository TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('publishing', 'published', 'failed')),
      number INTEGER,
      snapshot TEXT,
      error TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_pull_requests_workspace
      ON dispatch_pull_requests(workspace_id);
  `)
}
