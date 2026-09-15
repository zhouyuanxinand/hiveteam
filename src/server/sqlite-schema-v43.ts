import type { Database } from 'better-sqlite3'

export const applySchemaVersion43 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_review_drafts (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      base_revision TEXT NOT NULL,
      base_content TEXT NOT NULL,
      content TEXT NOT NULL,
      note TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, path)
    );
    CREATE TABLE IF NOT EXISTS workspace_review_confirmations (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      revision TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, path, revision)
    );
    CREATE TABLE IF NOT EXISTS workspace_review_submissions (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('answer', 'review')),
      path TEXT,
      identity TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('blocked', 'sending', 'submitted', 'uncertain')),
      error TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS workspace_review_submissions_path
      ON workspace_review_submissions(workspace_id, path, created_at);
  `)
}
