import type { Database } from './sqlite.js'

export const applySchemaVersion65 = (db: Database) => {
  const columns = new Set(
    (db.pragma('table_info(memory_dream_runs)') as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  db.transaction(() => {
    for (const [name, definition] of [
      ['plan_version', 'INTEGER NOT NULL DEFAULT 0'],
      ['plan_revision', 'INTEGER NOT NULL DEFAULT 0'],
      ['operations_json', "TEXT NOT NULL DEFAULT '[]'"],
      ['change_receipt_json', 'TEXT'],
    ] as const) {
      if (!columns.has(name))
        db.exec(`ALTER TABLE memory_dream_runs ADD COLUMN ${name} ${definition}`)
    }
  })()
}
