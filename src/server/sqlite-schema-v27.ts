import type { Database } from 'better-sqlite3'

/** Adds persisted workspace language and the explicit manual-stop marker. */
export const applySchemaVersion27 = (db: Database) => {
  const workspaceColumns = new Set(
    (db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (workspaceColumns.size > 0 && !workspaceColumns.has('language')) {
    db.exec("ALTER TABLE workspaces ADD COLUMN language TEXT NOT NULL DEFAULT 'zh'")
  }

  const workerColumns = new Set(
    (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (workerColumns.size > 0 && !workerColumns.has('manual_stop')) {
    db.exec('ALTER TABLE workers ADD COLUMN manual_stop INTEGER NOT NULL DEFAULT 0')
  }
}
