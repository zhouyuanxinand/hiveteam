import type { Database } from 'better-sqlite3'

export const applySchemaVersion38 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  db.transaction(() => {
    if (!columns.has('report_outcome')) {
      db.exec(
        "ALTER TABLE dispatches ADD COLUMN report_outcome TEXT CHECK (report_outcome IN ('success', 'failed', 'blocked', 'partial'))"
      )
    }
    if (!columns.has('report_revision')) {
      db.exec('ALTER TABLE dispatches ADD COLUMN report_revision INTEGER NOT NULL DEFAULT 0')
      db.exec("UPDATE dispatches SET report_revision = 1 WHERE status = 'reported'")
    }
    if (!columns.has('accepted_at')) {
      db.exec('ALTER TABLE dispatches ADD COLUMN accepted_at INTEGER')
    }
  })()
}
