import type { Database } from 'better-sqlite3'

export const applySchemaVersion40 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_worktrees (
      worker_id TEXT PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      repo_root TEXT NOT NULL,
      checkout_path TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      target_branch TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'failed')),
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS dispatch_integrations (
      verification_id TEXT PRIMARY KEY REFERENCES dispatch_verifications(id) ON DELETE CASCADE,
      target_sha TEXT NOT NULL,
      integrated_at INTEGER NOT NULL
    );
  `)
}
