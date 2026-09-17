import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { ReportDeliveryCheckpoint } from './report-delivery-receipt.js'

/**
 * Durable delivery queue for reports that could not be written into a live
 * Orchestrator. Codex checkpoints retain the same receipt across attempts so
 * retrying an uncertain submission does not paste the report again.
 */
export interface ReportOutboxEntry {
  checkpoint: ReportDeliveryCheckpoint | null
  receiptId: string
  createdAt: number
  deliveryAttemptCount: number
  deliveredAt: number | null
  dispatchId: string
  id: number
  lastDeliveryAttemptAt: number | null
  lastDeliveryError: string | null
  payload: string
  targetAgentId: string
  workspaceId: string
}

interface EnqueueInput {
  dispatchId: string
  payload: string
  targetAgentId: string
  workspaceId: string
}

interface ReportOutboxRow {
  delivery_checkpoint: string | null
  receipt_id: string
  created_at: number
  delivery_attempts: number
  delivered_at: number | null
  dispatch_id: string
  id: number
  last_delivery_attempt_at: number | null
  last_delivery_error: string | null
  payload: string
  target_agent_id: string
  workspace_id: string
}

const toEntry = (row: ReportOutboxRow): ReportOutboxEntry => ({
  checkpoint: row.delivery_checkpoint ? JSON.parse(row.delivery_checkpoint) : null,
  receiptId: row.receipt_id,
  createdAt: row.created_at,
  deliveryAttemptCount: row.delivery_attempts,
  deliveredAt: row.delivered_at,
  dispatchId: row.dispatch_id,
  id: row.id,
  lastDeliveryAttemptAt: row.last_delivery_attempt_at,
  lastDeliveryError: row.last_delivery_error,
  payload: row.payload,
  targetAgentId: row.target_agent_id,
  workspaceId: row.workspace_id,
})

export const createReportOutboxStore = (db: Database) => {
  // The team-list poll drains the outbox twice per second per workspace, so
  // every statement here is prepared once instead of on each call.
  const enqueueStmt = db.prepare(
    `INSERT OR IGNORE INTO report_outbox
      (workspace_id, target_agent_id, dispatch_id, payload, created_at, receipt_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const listPendingStmt = db.prepare(
    `SELECT id, workspace_id, target_agent_id, dispatch_id, payload, created_at, delivered_at,
            delivery_attempts, last_delivery_attempt_at, last_delivery_error, receipt_id, delivery_checkpoint
       FROM report_outbox
       WHERE workspace_id = ? AND target_agent_id = ? AND delivered_at IS NULL
       ORDER BY created_at ASC, id ASC`
  )
  const markDeliveredStmt = db.prepare(
    `UPDATE report_outbox
     SET delivered_at = ?, last_delivery_error = NULL
     WHERE id = ? AND delivered_at IS NULL`
  )
  const checkpointStmt = db.prepare(
    'UPDATE report_outbox SET delivery_checkpoint = ? WHERE id = ? AND receipt_id = ? AND delivered_at IS NULL'
  )
  const markDeliveryAttemptStmt = db.prepare(
    `UPDATE report_outbox
     SET delivery_attempts = delivery_attempts + 1,
         last_delivery_attempt_at = ?,
         last_delivery_error = NULL
     WHERE id = ? AND delivered_at IS NULL`
  )
  const markDeliveryFailedStmt = db.prepare(
    `UPDATE report_outbox
     SET last_delivery_error = ?, last_delivery_attempt_at = ?
     WHERE id = ? AND delivered_at IS NULL`
  )
  const deletePendingForDispatchStmt = db.prepare(
    'DELETE FROM report_outbox WHERE dispatch_id = ? AND delivered_at IS NULL'
  )
  const deleteWorkspaceEntriesStmt = db.prepare('DELETE FROM report_outbox WHERE workspace_id = ?')
  const deleteWorkerEntriesStmt = db.prepare(
    `DELETE FROM report_outbox
     WHERE workspace_id = ?
       AND (
         target_agent_id = ?
         OR dispatch_id IN (
           SELECT id FROM dispatches WHERE workspace_id = ? AND to_agent_id = ?
         )
       )`
  )
  const pendingCountStmt = db.prepare(
    `SELECT COUNT(*) AS count
       FROM report_outbox
       WHERE workspace_id = ? AND target_agent_id = ? AND delivered_at IS NULL`
  )

  const enqueue = (input: EnqueueInput) => {
    // A completed dispatch may be retried by a client after a transient
    // transport failure. Keep one durable report per dispatch, not duplicates.
    enqueueStmt.run(
      input.workspaceId,
      input.targetAgentId,
      input.dispatchId,
      input.payload,
      Date.now(),
      randomUUID()
    )
  }

  const listPending = (workspaceId: string, targetAgentId: string) =>
    (listPendingStmt.all(workspaceId, targetAgentId) as ReportOutboxRow[]).map(toEntry)

  const markDelivered = (id: number) => {
    markDeliveredStmt.run(Date.now(), id)
  }

  const markDeliveryAttempt = (id: number) => {
    markDeliveryAttemptStmt.run(Date.now(), id)
  }

  const markDeliveryFailed = (id: number, error: string) => {
    const message = error.trim().slice(0, 1_000) || 'The Orchestrator terminal rejected the report.'
    markDeliveryFailedStmt.run(message, Date.now(), id)
  }

  const deletePendingForDispatch = (dispatchId: string) => {
    deletePendingForDispatchStmt.run(dispatchId)
  }

  const deleteWorkspaceEntries = (workspaceId: string) => {
    deleteWorkspaceEntriesStmt.run(workspaceId)
  }

  const deleteWorkerEntries = (workspaceId: string, workerId: string) => {
    deleteWorkerEntriesStmt.run(workspaceId, workerId, workspaceId, workerId)
  }

  const pendingCount = (workspaceId: string, targetAgentId: string) =>
    (pendingCountStmt.get(workspaceId, targetAgentId) as { count: number }).count

  return {
    saveCheckpoint(id: number, receiptId: string, checkpoint: ReportDeliveryCheckpoint) {
      if (checkpointStmt.run(JSON.stringify(checkpoint), id, receiptId).changes !== 1)
        throw new Error('Report delivery was cancelled or superseded; input was not sent.')
    },
    deletePendingForDispatch,
    deleteWorkerEntries,
    deleteWorkspaceEntries,
    enqueue,
    listPending,
    markDeliveryAttempt,
    markDeliveryFailed,
    markDelivered,
    pendingCount,
  }
}

export type ReportOutboxStore = ReturnType<typeof createReportOutboxStore>
