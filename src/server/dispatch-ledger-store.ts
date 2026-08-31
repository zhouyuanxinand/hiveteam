import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

export type DispatchStatus = 'queued' | 'submitted' | 'failed' | 'reported' | 'cancelled'

export interface DispatchRecord {
  artifacts: string[]
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
  const createDispatch = (input: CreateDispatchInput) => {
    const record: DispatchRecord = {
      artifacts: [],
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

    db.prepare(
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
        artifacts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
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
      JSON.stringify(record.artifacts)
    )

    return record
  }

  const deleteDispatch = (dispatchId: string) => {
    db.transaction(() => {
      db.prepare('DELETE FROM dispatch_delivery_failures WHERE dispatch_id = ?').run(dispatchId)
      db.prepare('DELETE FROM dispatches WHERE id = ?').run(dispatchId)
    })()
  }

  const markSubmitted = (dispatchId: string) => {
    const submittedAt = Date.now()
    db.prepare(
      `UPDATE dispatches
       SET status = ?, submitted_at = ?
       WHERE id = ?`
    ).run('submitted', submittedAt, dispatchId)
    db.prepare('DELETE FROM dispatch_delivery_failures WHERE dispatch_id = ?').run(dispatchId)
  }

  const markDeliveryFailed = (dispatchId: string, error: string) => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO dispatch_delivery_failures (dispatch_id, attempts, last_error, last_attempt_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(dispatch_id) DO UPDATE SET
         attempts = dispatch_delivery_failures.attempts + 1,
         last_error = excluded.last_error,
         last_attempt_at = excluded.last_attempt_at`
    ).run(dispatchId, error, now)
  }

  const findOpenDispatch = (workspaceId: string, toAgentId: string, dispatchId?: string) => {
    if (dispatchId) {
      const row = db
        .prepare(
          `${dispatchSelect}
            WHERE d.id = ?
              AND d.workspace_id = ?
              AND d.to_agent_id = ?
              AND d.status IN ('queued', 'submitted')
            LIMIT 1`
        )
        .get(dispatchId, workspaceId, toAgentId) as DispatchRow | undefined

      return row ? toRecord(row) : undefined
    }

    const row = db
      .prepare(
        `${dispatchSelect}
          WHERE d.workspace_id = ?
            AND d.to_agent_id = ?
            AND d.status IN ('queued', 'submitted')
          ORDER BY d.sequence ASC
          LIMIT 1`
      )
      .get(workspaceId, toAgentId) as DispatchRow | undefined

    return row ? toRecord(row) : undefined
  }

  const findOpenDispatchById = (workspaceId: string, dispatchId: string) => {
    const row = db
      .prepare(
        `${dispatchSelect}
         WHERE d.id = ?
           AND d.workspace_id = ?
           AND d.status IN ('queued', 'submitted')
         LIMIT 1`
      )
      .get(dispatchId, workspaceId) as DispatchRow | undefined

    return row ? toRecord(row) : undefined
  }

  const markReportedByWorker = (input: ReportDispatchInput) => {
    const dispatch = findOpenDispatch(input.workspaceId, input.toAgentId, input.dispatchId)
    if (!dispatch) {
      return undefined
    }

    const reportedAt = Date.now()
    db.prepare(
      `UPDATE dispatches
       SET status = ?,
           reported_at = ?,
           report_text = ?,
           artifacts = ?
       WHERE id = ?`
    ).run('reported', reportedAt, input.reportText, JSON.stringify(input.artifacts), dispatch.id)
    db.prepare('DELETE FROM dispatch_delivery_failures WHERE dispatch_id = ?').run(dispatch.id)

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
    db.prepare(
      `UPDATE dispatches
       SET status = ?,
           reported_at = ?,
           report_text = ?
       WHERE id = ?`
    ).run('cancelled', cancelledAt, input.reason, dispatch.id)
    db.prepare('DELETE FROM dispatch_delivery_failures WHERE dispatch_id = ?').run(dispatch.id)

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
    return (
      db
        .prepare(
          `${dispatchSelect}
           WHERE d.workspace_id = ?
             ${statusClause}
           ORDER BY d.sequence ASC
           LIMIT ? OFFSET ?`
        )
        .all(...values) as DispatchRow[]
    ).map(toRecord)
  }

  const listOpenDispatchKinds = () => {
    return db
      .prepare(
        `SELECT workspace_id, to_agent_id AS worker_id, 'send' AS type
           FROM dispatches
           WHERE status IN ('queued', 'submitted')
           ORDER BY sequence ASC`
      )
      .all() as Array<{ type: 'send'; worker_id: string; workspace_id: string }>
  }

  const deleteWorkspaceDispatches = (workspaceId: string) => {
    db.transaction(() => {
      db.prepare(
        `DELETE FROM dispatch_delivery_failures
         WHERE dispatch_id IN (SELECT id FROM dispatches WHERE workspace_id = ?)`
      ).run(workspaceId)
      db.prepare('DELETE FROM dispatches WHERE workspace_id = ?').run(workspaceId)
    })()
  }

  const deleteWorkerDispatches = (workspaceId: string, workerId: string) => {
    db.transaction(() => {
      db.prepare(
        `DELETE FROM dispatch_delivery_failures
         WHERE dispatch_id IN (
           SELECT id FROM dispatches WHERE workspace_id = ? AND to_agent_id = ?
         )`
      ).run(workspaceId, workerId)
      db.prepare('DELETE FROM dispatches WHERE workspace_id = ? AND to_agent_id = ?').run(
        workspaceId,
        workerId
      )
    })()
  }

  return {
    createDispatch,
    deleteDispatch,
    deleteWorkerDispatches,
    deleteWorkspaceDispatches,
    findOpenDispatch,
    findOpenDispatchById,
    listOpenDispatchKinds,
    listWorkspaceDispatches,
    markDeliveryFailed,
    markCancelled,
    markReportedByWorker,
    markSubmitted,
  }
}
