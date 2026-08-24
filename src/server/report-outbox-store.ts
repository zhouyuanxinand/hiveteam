import type { Database } from 'better-sqlite3'

/**
 * Durable delivery queue for reports that could not be written into a live
 * Orchestrator PTY. A dispatch id is unique, so a worker report is replayed at
 * most once after its terminal accepts the input.
 */
export interface ReportOutboxEntry {
  createdAt: number
  deliveredAt: number | null
  dispatchId: string
  id: number
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
  created_at: number
  delivered_at: number | null
  dispatch_id: string
  id: number
  payload: string
  target_agent_id: string
  workspace_id: string
}

const toEntry = (row: ReportOutboxRow): ReportOutboxEntry => ({
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  dispatchId: row.dispatch_id,
  id: row.id,
  payload: row.payload,
  targetAgentId: row.target_agent_id,
  workspaceId: row.workspace_id,
})

export const createReportOutboxStore = (db: Database) => {
  const enqueue = (input: EnqueueInput) => {
    // A completed dispatch may be retried by a client after a transient
    // transport failure. Keep one durable report per dispatch, not duplicates.
    db.prepare(
      `INSERT OR IGNORE INTO report_outbox
        (workspace_id, target_agent_id, dispatch_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(input.workspaceId, input.targetAgentId, input.dispatchId, input.payload, Date.now())
  }

  const listPending = (workspaceId: string, targetAgentId: string) =>
    (
      db
        .prepare(
          `SELECT id, workspace_id, target_agent_id, dispatch_id, payload, created_at, delivered_at
             FROM report_outbox
             WHERE workspace_id = ? AND target_agent_id = ? AND delivered_at IS NULL
             ORDER BY created_at ASC, id ASC`
        )
        .all(workspaceId, targetAgentId) as ReportOutboxRow[]
    ).map(toEntry)

  const markDelivered = (id: number) => {
    db.prepare(
      'UPDATE report_outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL'
    ).run(Date.now(), id)
  }

  const deletePendingForDispatch = (dispatchId: string) => {
    db.prepare('DELETE FROM report_outbox WHERE dispatch_id = ? AND delivered_at IS NULL').run(
      dispatchId
    )
  }

  const deleteWorkspaceEntries = (workspaceId: string) => {
    db.prepare('DELETE FROM report_outbox WHERE workspace_id = ?').run(workspaceId)
  }

  const deleteWorkerEntries = (workspaceId: string, workerId: string) => {
    db.prepare(
      `DELETE FROM report_outbox
       WHERE workspace_id = ?
         AND (
           target_agent_id = ?
           OR dispatch_id IN (
             SELECT id FROM dispatches WHERE workspace_id = ? AND to_agent_id = ?
           )
         )`
    ).run(workspaceId, workerId, workspaceId, workerId)
  }

  const pendingCount = (workspaceId: string, targetAgentId: string) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM report_outbox
             WHERE workspace_id = ? AND target_agent_id = ? AND delivered_at IS NULL`
        )
        .get(workspaceId, targetAgentId) as { count: number }
    ).count

  return {
    deletePendingForDispatch,
    deleteWorkerEntries,
    deleteWorkspaceEntries,
    enqueue,
    listPending,
    markDelivered,
    pendingCount,
  }
}

export type ReportOutboxStore = ReturnType<typeof createReportOutboxStore>
