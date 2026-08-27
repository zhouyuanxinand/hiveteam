import type { Database } from 'better-sqlite3'

export const applySchemaVersion24 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS git_workspace_settings (
      workspace_id TEXT PRIMARY KEY,
      repo_root TEXT,
      relative_path TEXT,
      state TEXT NOT NULL DEFAULT 'unknown',
      auto_snapshot INTEGER NOT NULL DEFAULT 1,
      last_checked_at INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS git_snapshots (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      turn_id TEXT,
      commit_sha TEXT NOT NULL UNIQUE,
      parent_sha TEXT,
      branch TEXT,
      message TEXT NOT NULL,
      changed_files INTEGER NOT NULL DEFAULT 0,
      insertions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'created',
      error TEXT,
      created_at INTEGER NOT NULL,
      reverted_by_sha TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_git_snapshots_workspace_created
      ON git_snapshots (workspace_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_git_snapshots_turn
      ON git_snapshots (workspace_id, turn_id);
  `)
}
