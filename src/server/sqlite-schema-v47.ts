import { randomUUID } from 'node:crypto'
import type { Database } from './sqlite.js'

export const applySchemaVersion47 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(report_outbox)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('receipt_id')) db.exec('ALTER TABLE report_outbox ADD COLUMN receipt_id TEXT')
  if (!columns.has('delivery_checkpoint'))
    db.exec('ALTER TABLE report_outbox ADD COLUMN delivery_checkpoint TEXT')
  const update = db.prepare('UPDATE report_outbox SET receipt_id = ? WHERE id = ?')
  db.transaction(() => {
    for (const row of db
      .prepare('SELECT id FROM report_outbox WHERE receipt_id IS NULL')
      .all() as Array<{ id: number }>)
      update.run(randomUUID(), row.id)
  })()
}
