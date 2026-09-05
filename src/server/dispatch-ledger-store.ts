import { randomUUID } from 'node:crypto'

import type { Database, Statement } from 'better-sqlite3'

export type DispatchStatus = 'queued' | 'submitted' | 'failed' | 'reported' | 'cancelled'

export interface DispatchRecord {
  artifacts: string[]
  /**
   * Git HEAD of the workspace captured when the dispatch was created. Serves
   * as the baseline for reviewing what changed while the dispatch was worked
   * on. Null for dispatches created before this tracking existed or when the
   * workspace is not a Git repository.
   */
  baseHeadSha: string | null
  createdAt: number
  deliveredAt: number | null
  fromAgentId: string | null
  id: string
  reportedAt: number | null
  reportText: string | null
  sequence: number | null
  status: DispatchStatus
  submittedAt: number | null
  text: string
  toAgentId: string
  workspaceId: string
  /** Present only when the last delivery attempt failed. */
  attemptCount?: number
  lastAttemptAt?: number
  lastError?: string
  /**
   * A worker can complete its dispatch while the durable report to the
   * Orchestrator remains queued. Keep this separate from a failed dispatch so
   * the worker is not shown as having unfinished work again.
   */
  reportDelivery?: {
    attemptCount: number
    deliveredAt: number | null
    lastAttemptAt: number | null
    lastError: string | null
  }
}

interface DispatchRow {
  artifacts: string | null
  base_head_sha?: string | null
  created_at: number
  delivered_at: number | null
  from_agent_id: string | null
  id: string
  reported_at: number | null
  report_text: string | null
  sequence: number
  status: DispatchStatus
  submitted_at: number | null
  text: string
  to_agent_id: string
  workspace_id: string
  failure_dispatch_id?: string | null
  failure_attempts?: number | null
  failure_last_attempt_at?: number | null
  failure_last_error?: string | null
  report_outbox_id?: number | null
  report_delivery_attempts?: number | null
  report_delivered_at?: number | null
  report_last_delivery_attempt_at?: number | null
  report_last_delivery_error?: string | null
}

interface CreateDispatchInput {
  baseHeadSha?: string | null
  fromAgentId?: string
  text: string
  toAgentId: string
  workspaceId: string
}

interface ReportDispatchInput {
  artifacts: string[]
  dispatchId?: string
  reportText: string
  toAgentId: string
  workspaceId: string
}

interface CancelDispatchInput {
  dispatchId: string
  reason: string
  workspaceId: string
}

export interface ListDispatchesOptions {
  limit?: number
  offset?: number
  status?: DispatchStatus
}

const parseArtifacts = (value: string | null) => {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((artifact): artifact is string => typeof artifact === 'string')
      : []
  } catch {
    return []
  }
}

const toRecord = (row: DispatchRow): DispatchRecord => {
  const record: DispatchRecord = {
    artifacts: parseArtifacts(row.artifacts),
    baseHeadSha: row.base_head_sha ?? null,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    fromAgentId: row.from_agent_id,
    id: row.id,
    reportedAt: row.reported_at,
    reportText: row.report_text,
    sequence: row.sequence,
    status: row.failure_dispatch_id ? 'failed' : row.status,
    submittedAt: row.submitted_at,
    text: row.text,
    toAgentId: row.to_agent_id,
    workspaceId: row.workspace_id,
  }
  if (row.failure_dispatch_id) {
    record.attemptCount = row.failure_attempts ?? 0
    record.lastAttemptAt = row.failure_last_attempt_at ?? 0
    record.lastError = row.failure_last_error ?? 'Dispatch delivery failed'
  }
  if (row.report_outbox_id !== null && row.report_outbox_id !== undefined) {
    record.reportDelivery = {
      attemptCount: row.report_delivery_attempts ?? 0,
      deliveredAt: row.report_delivered_at ?? null,
      lastAttemptAt: row.report_last_delivery_attempt_at ?? null,
      lastError: row.report_last_delivery_error ?? null,
    }
  }
  return record
}

const dispatchSelect = `
  SELECT d.*,
         f.dispatch_id AS failure_dispatch_id,
         f.attempts AS failure_attempts,
         f.last_attempt_at AS failure_last_attempt_at,
         f.last_error AS failure_last_error,
         r.id AS report_outbox_id,
         r.delivery_attempts AS report_delivery_attempts,
         r.delivered_at AS report_delivered_at,
         r.last_delivery_attempt_at AS report_last_delivery_attempt_at,
         r.last_delivery_error AS report_last_delivery_error
    FROM dispatches d
    LEFT JOIN dispatch_delivery_failures f ON f.dispatch_id = d.id
    LEFT JOIN report_outbox r ON r.dispatch_id = d.id
`

export const createDispatchLedgerStore = (db: Database) => {
  // Statement handles are prepared once: the team-list poll runs the pending
  // counts twice per second per workspace, and prepare-per-call dominated the
  // CPU cost of that endpoint.
  const insertDispatchStmt = db.prepare(
    `INSERT INTO dispatches (
      id,
      workspace_id,
      from_agent_id,
      to_agent_id,
      text,
      status,
      created_at,
      delivered_at,
      submitted_at,
      reported_at,
      report_text,
      artifacts,
      base_head_sha
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const deleteFailureStmt = db.prepare(
    'DELETE FROM dispatch_delivery_failures WHERE dispatch_id = ?'
  )
  const deleteDispatchStmt = db.prepare('DELETE FROM dispatches WHERE id = ?')
  const markSubmittedStmt = db.prepare(
    `UPDATE dispatches
     SET status = ?, submitted_at = ?
     WHERE id = ?`
  )
  const upsertFailureStmt = db.prepare(
    `INSERT INTO dispatch_delivery_failures (dispatch_id, attempts, last_error, last_attempt_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(dispatch_id) DO UPDATE SET
       attempts = dispatch_delivery_failures.attempts + 1,
       last_error = excluded.last_error,
       last_attempt_at = excluded.last_attempt_at`
  )
  const findOpenByIdForWorkerStmt = db.prepare(
    `${dispatchSelect}
      WHERE d.id = ?
        AND d.workspace_id = ?
        AND d.to_agent_id = ?
        AND d.status IN ('queued', 'submitted')
      LIMIT 1`
  )
  const findOpenForWorkerStmt = db.prepare(
    `${dispatchSelect}
      WHERE d.workspace_id = ?
        AND d.to_agent_id = ?
        AND d.status IN ('queued', 'submitted')
      ORDER BY d.sequence ASC
      LIMIT 1`
  )
  const findOpenByIdStmt = db.prepare(
    `${dispatchSelect}
     WHERE d.id = ?
       AND d.workspace_id = ?
       AND d.status IN ('queued', 'submitted')
     LIMIT 1`
  )
  const markReportedStmt = db.prepare(
    `UPDATE dispatches
     SET status = ?,
         reported_at = ?,
         report_text = ?,
         artifacts = ?
     WHERE id = ?`
  )
  const markCancelledStmt = db.prepare(
    `UPDATE dispatches
     SET status = ?,
         reported_at = ?,
         report_text = ?
     WHERE id = ?`
  )
  const listOpenKindsStmt = db.prepare(
    `SELECT workspace_id, to_agent_id AS worker_id, 'send' AS type
       FROM dispatches
       WHERE status IN ('queued', 'submitted')
       ORDER BY sequence ASC`
  )
  const deleteWorkspaceFailuresStmt = db.prepare(
    `DELETE FROM dispatch_delivery_failures
     WHERE dispatch_id IN (SELECT id FROM dispatches WHERE workspace_id = ?)`
  )
  const deleteWorkspaceDispatchesStmt = db.prepare('DELETE FROM dispatches WHERE workspace_id = ?')
  const deleteWorkerFailuresStmt = db.prepare(
    `DELETE FROM dispatch_delivery_failures
     WHERE dispatch_id IN (
       SELECT id FROM dispatches WHERE workspace_id = ? AND to_agent_id = ?
     )`
  )
  const deleteWorkerDispatchesStmt = db.prepare(
    'DELETE FROM dispatches WHERE workspace_id = ? AND to_agent_id = ?'
  )
  const countPendingByWorkerStmt = db.prepare(
    `SELECT d.to_agent_id AS worker_id, COUNT(*) AS pending
       FROM dispatches d
       LEFT JOIN dispatch_delivery_failures f ON f.dispatch_id = d.id
       WHERE d.workspace_id = ?
         AND (d.status IN ('queued', 'submitted') OR f.dispatch_id IS NOT NULL)
       GROUP BY d.to_agent_id`
  )
  // The status filter has a closed set of shapes, so each variant is prepared
  // once and reused instead of re-parsing the JOIN on every list call.
  const listDispatchStmts = new Map<string, Statement>()
  const listDispatchesStmt = (statusClause: string) => {
    let stmt = listDispatchStmts.get(statusClause)
    if (!stmt) {
      stmt = db.prepare(
        `${dispatchSelect}
         WHERE d.workspace_id = ?
           ${statusClause}
         ORDER BY d.sequence ASC
         LIMIT ? OFFSET ?`
      )
      listDispatchStmts.set(statusClause, stmt)
    }
    return stmt
  }

  const createDispatch = (input: CreateDispatchInput) => {
    const record: DispatchRecord = {
      artifacts: [],
      baseHeadSha: input.baseHeadSha ?? null,
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: input.fromAgentId ?? null,
      id: randomUUID(),
      reportedAt: null,
      reportText: null,
      sequence: null,
      status: 'queued',
      submittedAt: null,
      text: input.text,
      toAgentId: input.toAgentId,
      workspaceId: input.workspaceId,
    }

    insertDispatchStmt.run(
      record.id,
      record.workspaceId,
      record.fromAgentId,
      record.toAgentId,
      record.text,
      record.status,
      record.createdAt,
      record.deliveredAt,
      record.submittedAt,
      record.reportedAt,
      record.reportText,
      JSON.stringify(record.artifacts),
      record.baseHeadSha
    )

    return record
  }

  const getDispatchById = (workspaceId: string, dispatchId: string) => {
    const row = db
      .prepare(
        `${dispatchSelect}
         WHERE d.id = ?
           AND d.workspace_id = ?
         LIMIT 1`
      )
      .get(dispatchId, workspaceId) as DispatchRow | undefined

    return row ? toRecord(row) : undefined
  }

  const deleteDispatch = (dispatchId: string) => {
    db.transaction(() => {
      deleteFailureStmt.run(dispatchId)
      deleteDispatchStmt.run(dispatchId)
    })()
  }

  const setBaseHeadSha = (dispatchId: string, baseHeadSha: string) => {
    db.prepare('UPDATE dispatches SET base_head_sha = ? WHERE id = ?').run(baseHeadSha, dispatchId)
  }

  /**
   * Reopen a reported dispatch when review feedback arrives, so the worker
   * can address it and report again under the same dispatch id. Returns false
   * when the dispatch is not currently in the reported state.
   */
  const reopenReportedDispatch = (workspaceId: string, dispatchId: string) => {
    const result = db
      .prepare(
        `UPDATE dispatches
         SET status = 'submitted',
             reported_at = NULL,
             report_text = NULL,
             artifacts = '[]'
         WHERE id = ? AND workspace_id = ? AND status = 'reported'`
      )
      .run(dispatchId, workspaceId)
    if (result.changes === 0) return false
    db.prepare('DELETE FROM dispatch_delivery_failures WHERE dispatch_id = ?').run(dispatchId)
    return true
  }

  const markSubmitted = (dispatchId: string) => {
    const submittedAt = Date.now()
    markSubmittedStmt.run('submitted', submittedAt, dispatchId)
    deleteFailureStmt.run(dispatchId)
  }

  const markDeliveryFailed = (dispatchId: string, error: string) => {
    const now = Date.now()
    upsertFailureStmt.run(dispatchId, error, now)
  }

  const findOpenDispatch = (workspaceId: string, toAgentId: string, dispatchId?: string) => {
    if (dispatchId) {
      const row = findOpenByIdForWorkerStmt.get(dispatchId, workspaceId, toAgentId) as
        | DispatchRow
        | undefined

      return row ? toRecord(row) : undefined
    }

    const row = findOpenForWorkerStmt.get(workspaceId, toAgentId) as DispatchRow | undefined

    return row ? toRecord(row) : undefined
  }

  const findOpenDispatchById = (workspaceId: string, dispatchId: string) => {
    const row = findOpenByIdStmt.get(dispatchId, workspaceId) as DispatchRow | undefined

    return row ? toRecord(row) : undefined
  }

  const markReportedByWorker = (input: ReportDispatchInput) => {
    const dispatch = findOpenDispatch(input.workspaceId, input.toAgentId, input.dispatchId)
    if (!dispatch) {
      return undefined
    }

    const reportedAt = Date.now()
    markReportedStmt.run(
      'reported',
      reportedAt,
      input.reportText,
      JSON.stringify(input.artifacts),
      dispatch.id
    )
    deleteFailureStmt.run(dispatch.id)

    return {
      ...dispatch,
      artifacts: input.artifacts,
      reportedAt,
      reportText: input.reportText,
      status: 'reported' as const,
    }
  }

  const markCancelled = (input: CancelDispatchInput) => {
    const dispatch = findOpenDispatchById(input.workspaceId, input.dispatchId)
    if (!dispatch) {
      return undefined
    }

    const cancelledAt = Date.now()
    markCancelledStmt.run('cancelled', cancelledAt, input.reason, dispatch.id)
    deleteFailureStmt.run(dispatch.id)

    return {
      ...dispatch,
      reportedAt: cancelledAt,
      reportText: input.reason,
      status: 'cancelled' as const,
    }
  }

  const listWorkspaceDispatches = (workspaceId: string, options: ListDispatchesOptions = {}) => {
    const offset = options.offset ?? 0
    const limit = options.limit ?? 100
    const statusClause =
      options.status === 'failed'
        ? 'AND f.dispatch_id IS NOT NULL'
        : options.status === 'queued'
          ? 'AND d.status = ? AND f.dispatch_id IS NULL'
          : options.status
            ? 'AND d.status = ?'
            : ''
    const values: Array<string | number> = [workspaceId]
    if (options.status && options.status !== 'failed') values.push(options.status)
    values.push(limit, offset)
    return (listDispatchesStmt(statusClause).all(...values) as DispatchRow[]).map(toRecord)
  }

  const listOpenDispatchKinds = () => {
    return listOpenKindsStmt.all() as Array<{
      type: 'send'
      worker_id: string
      workspace_id: string
    }>
  }

  const countPendingByWorker = (workspaceId: string) => {
    const counts = new Map<string, number>()
    for (const row of countPendingByWorkerStmt.all(workspaceId) as Array<{
      pending: number
      worker_id: string
    }>) {
      counts.set(row.worker_id, Number(row.pending))
    }
    return counts
  }

  const deleteWorkspaceDispatches = (workspaceId: string) => {
    db.transaction(() => {
      deleteWorkspaceFailuresStmt.run(workspaceId)
      deleteWorkspaceDispatchesStmt.run(workspaceId)
    })()
  }

  const deleteWorkerDispatches = (workspaceId: string, workerId: string) => {
    db.transaction(() => {
      deleteWorkerFailuresStmt.run(workspaceId, workerId)
      deleteWorkerDispatchesStmt.run(workspaceId, workerId)
    })()
  }

  return {
    countPendingByWorker,
    createDispatch,
    deleteDispatch,
    deleteWorkerDispatches,
    deleteWorkspaceDispatches,
    findOpenDispatch,
    findOpenDispatchById,
    getDispatchById,
    listOpenDispatchKinds,
    listWorkspaceDispatches,
    markDeliveryFailed,
    markCancelled,
    markReportedByWorker,
    markSubmitted,
    reopenReportedDispatch,
    setBaseHeadSha,
  }
}
