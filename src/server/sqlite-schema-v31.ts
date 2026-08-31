import type { Database } from 'better-sqlite3'

/** Persists structured references for procedure-ref team memories. */
export const applySchemaVersion31 = (db: Database) => {
  const memoryColumns = new Set(
    (db.prepare('PRAGMA table_info(memory_entries)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!memoryColumns.has('ref_type')) {
    db.exec('ALTER TABLE memory_entries ADD COLUMN ref_type TEXT')
  }
  if (!memoryColumns.has('ref_id')) {
    db.exec('ALTER TABLE memory_entries ADD COLUMN ref_id TEXT')
  }
  if (!memoryColumns.has('ref_title')) {
    db.exec('ALTER TABLE memory_entries ADD COLUMN ref_title TEXT')
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_entries_ref
      ON memory_entries(ref_type, ref_id)
      WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;
  `)
}
