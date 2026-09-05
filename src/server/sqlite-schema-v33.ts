import type { Database } from 'better-sqlite3'

/**
 * Records the workspace Git HEAD at dispatch creation time so the UI can show
 * what changed while a dispatch was being worked on.
 */
export const applySchemaVersion33 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('base_head_sha')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN base_head_sha TEXT')
  }
}
