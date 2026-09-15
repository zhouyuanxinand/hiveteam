import type { Database } from 'better-sqlite3'

export const applySchemaVersion44 = (db: Database) => {
  const columns = db.pragma('table_info(workspace_review_submissions)') as { name: string }[]
  if (!columns.some((column) => column.name === 'agent_id'))
    db.exec('ALTER TABLE workspace_review_submissions ADD COLUMN agent_id TEXT')
  db.exec(
    "UPDATE workspace_review_submissions SET agent_id = workspace_id || ':orchestrator' WHERE agent_id IS NULL"
  )
}
