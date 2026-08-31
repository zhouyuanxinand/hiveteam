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
  `)

  // Databases created by newer official Hive builds can already report a
  // schema version above v26 while using a different workflow_runs shape.
  // `CREATE TABLE IF NOT EXISTS` does not upgrade an existing table, so make
  // the columns required by this runtime available before creating indexes or
  // opening the workflow service. Every operation is guarded and therefore
  // safe to run on both old and current databases.
  const workflowColumns = new Set(
    (db.prepare('PRAGMA table_info(workflow_runs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  const addColumn = (name: string, definition: string) => {
    if (workflowColumns.has(name)) return
    db.exec(`ALTER TABLE workflow_runs ADD COLUMN ${name} ${definition}`)
    workflowColumns.add(name)
  }

  addColumn('workflow_id', "TEXT NOT NULL DEFAULT ''")
  addColumn('name', "TEXT NOT NULL DEFAULT 'Workflow'")
  addColumn('definition_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumn('steps_json', "TEXT NOT NULL DEFAULT '[]'")
  addColumn('hive_port', "TEXT NOT NULL DEFAULT ''")
  addColumn('status', "TEXT NOT NULL DEFAULT 'running'")
  addColumn('error', 'TEXT')
  addColumn('created_at', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('started_at', 'INTEGER')
  addColumn('ended_at', 'INTEGER')
  addColumn('updated_at', 'INTEGER NOT NULL DEFAULT 0')

  const now = Date.now()
  if (workflowColumns.has('finished_at')) {
    db.prepare(
      'UPDATE workflow_runs SET ended_at = COALESCE(ended_at, finished_at) WHERE ended_at IS NULL AND finished_at IS NOT NULL'
    ).run()
    db.prepare(
      'UPDATE workflow_runs SET updated_at = COALESCE(NULLIF(updated_at, 0), finished_at, started_at, created_at, ?)'
    ).run(now)
  } else {
    db.prepare(
      'UPDATE workflow_runs SET updated_at = COALESCE(NULLIF(updated_at, 0), started_at, created_at, ?)'
    ).run(now)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_dream_reviews_dream
      ON memory_dream_reviews (workspace_id, dream_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace_created
      ON workflow_runs (workspace_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
      ON workflow_runs (workspace_id, status, updated_at DESC);
  `)
}
