import type { Database } from 'better-sqlite3'

export const applySchemaVersion25 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_dream_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'review',
      suggestions_json TEXT NOT NULL,
      source_snapshots_json TEXT NOT NULL,
      created_memory_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      submitted_at INTEGER,
      rolled_back_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_dream_runs_workspace_created
      ON memory_dream_runs (workspace_id, created_at DESC);
  `)
}
