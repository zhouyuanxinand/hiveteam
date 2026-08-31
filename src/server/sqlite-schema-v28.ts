import type { Database } from 'better-sqlite3'

/**
 * Retain actionable diagnostics for reports waiting in the durable outbox.
 *
 * A report can already be recorded as completed by its worker while writing
 * it to the Orchestrator PTY fails. These columns intentionally live on the
 * outbox rather than dispatch_delivery_failures: the dispatch itself remains
 * reported, and only its follow-up delivery is pending.
 */
export const applySchemaVersion28 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(report_outbox)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )

  if (columns.size === 0) return
  if (!columns.has('delivery_attempts')) {
    db.exec('ALTER TABLE report_outbox ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0')
  }
  if (!columns.has('last_delivery_attempt_at')) {
    db.exec('ALTER TABLE report_outbox ADD COLUMN last_delivery_attempt_at INTEGER')
  }
  if (!columns.has('last_delivery_error')) {
    db.exec('ALTER TABLE report_outbox ADD COLUMN last_delivery_error TEXT')
  }
}
