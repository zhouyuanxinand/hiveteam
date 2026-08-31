import type { Database } from 'better-sqlite3'

/** Adds a local custom image to persisted worker profiles. */
export const applySchemaVersion30 = (db: Database) => {
  const workerColumns = new Set(
    (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!workerColumns.has('avatar')) {
    db.exec('ALTER TABLE workers ADD COLUMN avatar TEXT')
  }
}
