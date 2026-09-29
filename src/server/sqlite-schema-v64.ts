import type { Database } from './sqlite.js'

export const applySchemaVersion64 = (db: Database) => {
  const columns = db.pragma('table_info(memory_sources)') as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'source_workspace_id')) {
    db.exec('ALTER TABLE memory_sources ADD COLUMN source_workspace_id TEXT')
  }
}
