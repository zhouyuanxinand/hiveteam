import type { Database } from './sqlite.js'

export const applySchemaVersion45 = (db: Database) => {
  const columns = db.pragma('table_info(agent_runs)') as { name: string }[]
  if (!columns.some((column) => column.name === 'resume_on_restart')) {
    db.exec(
      'ALTER TABLE agent_runs ADD COLUMN resume_on_restart INTEGER NOT NULL DEFAULT 0 CHECK (resume_on_restart IN (0, 1))'
    )
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started ON agent_runs (agent_id, started_at DESC)'
  )
}
