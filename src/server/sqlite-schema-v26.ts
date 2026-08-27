import type { Database } from 'better-sqlite3'

export const applySchemaVersion26 = (db: Database) => {
  const dreamColumns = new Set(
    (db.prepare('PRAGMA table_info(memory_dream_runs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (dreamColumns.size > 0 && !dreamColumns.has('execution_status')) {
    db.exec(
      "ALTER TABLE memory_dream_runs ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'queued'"
    )
  }
  if (dreamColumns.size > 0 && !dreamColumns.has('orchestrator_run_id')) {
    db.exec('ALTER TABLE memory_dream_runs ADD COLUMN orchestrator_run_id TEXT')
  }
  if (dreamColumns.size > 0 && !dreamColumns.has('execution_error')) {
    db.exec('ALTER TABLE memory_dream_runs ADD COLUMN execution_error TEXT')
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_dream_reviews (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      dream_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'queued',
      review_text TEXT,
      suggestions_json TEXT NOT NULL DEFAULT '[]',
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_dream_reviews_dream
      ON memory_dream_reviews (workspace_id, dream_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      name TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      hive_port TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace_created
      ON workflow_runs (workspace_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
      ON workflow_runs (workspace_id, status, updated_at DESC);
  `)
}
