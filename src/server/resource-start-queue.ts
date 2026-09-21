import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { ExecutionKind, ResourceReservation } from '../shared/resource-budget.js'
import type { ResourceQueueEntry, ResourceQueueSource } from '../shared/resource-queue.js'
import { ConflictError } from './http-errors.js'
import {
  captureRemoteQueueGrant,
  type RemoteQueueGrant,
  withoutRemoteActionContext,
  withRemoteActionCheck,
} from './remote-action-context.js'
import { type ResourceBudgetStore, ResourceLimitError } from './resource-budget-store.js'

export interface ResourceQueueWork extends ResourceQueueEntry {
  payload: Record<string, unknown>
  reservation_id: string
}
export interface ResourceQueueResult {
  runId?: string | null
}
type QueueHandler = (entry: ResourceQueueWork) => Promise<ResourceQueueResult>
export class ResourceQueueWaitError extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}
interface QueueHandlerOptions {
  ready?: (entry: ResourceQueueEntry, payload: Record<string, unknown>) => void
  assertCancellable?: (entry: ResourceQueueEntry) => void
  cancel?: (entry: ResourceQueueEntry) => void | Promise<void>
  failed?: (entry: ResourceQueueEntry, error: unknown) => void | Promise<void>
}
type QueueRow = ResourceQueueEntry & {
  sequence: number
  payload_json: string
  remote_guard_json: string | null
  reservation_id: string | null
}
export interface EnqueueResourceStart {
  workspaceId: string
  agentId?: string | null
  executionKey: string
  kind: ExecutionKind
  source: ResourceQueueSource
  payload: Record<string, unknown>
  reason?: string
}
const dto = (row: QueueRow): ResourceQueueEntry => ({
  id: row.id,
  workspace_id: row.workspace_id,
  agent_id: row.agent_id,
  execution_key: row.execution_key,
  kind: row.kind,
  source: row.source,
  status: row.status,
  reason: row.reason,
  created_at: row.created_at,
  updated_at: row.updated_at,
  run_id: row.run_id,
  attempts: row.attempts,
})

/** Durable workspaces round-robin, FIFO within each workspace; admission remains SQLite atomic. */
export const createResourceStartQueue = (input: {
  db: Database
  budget: ResourceBudgetStore
  validateRemoteGrant: (grant: RemoteQueueGrant) => void
  auditExecution?: (
    entry: ResourceQueueEntry,
    guard: RemoteQueueGrant,
    result: 'authorized' | 'ok' | 'error'
  ) => void
}) => {
  const { db, budget } = input
  const handlers = new Map<ResourceQueueSource, { run: QueueHandler } & QueueHandlerOptions>()
  let cancelAgent: ((workspaceId: string, agentId: string, pause: boolean) => void) | undefined
  let closed = false
  let scheduled = false
  let running: Promise<void> | null = null
  let wakeAgain = false
  const pendingCancellations = new Set<Promise<void>>()
  const get = (id: string) =>
    db.prepare('SELECT * FROM resource_start_queue WHERE id = ?').get(id) as QueueRow | undefined
  const finish = (
    id: string,
    status: ResourceQueueEntry['status'],
    reason: string | null,
    runId: string | null = null
  ) => {
    db.prepare(
      "UPDATE resource_start_queue SET status = ?, reason = ?, run_id = ?, updated_at = ? WHERE id = ? AND status != 'cancelled'"
    ).run(status, reason, runId, Date.now(), id)
  }
  // A previous claim is never blindly replayed: the budget retains uncertain
  // processes and refuses the execution key until reconciliation confirms exit.
  db.prepare(
    "UPDATE resource_start_queue SET status='queued', reason='runtime_recovery', updated_at=? WHERE status='starting'"
  ).run(Date.now())

  const check = (row: QueueRow) => {
    if (closed) throw new ConflictError('The resource queue is closing')
    const current = get(row.id)
    if (!current || current.status === 'cancelled' || current.status === 'failed')
      throw new ConflictError('This start request is no longer active')
    if (row.remote_guard_json)
      input.validateRemoteGrant(JSON.parse(row.remote_guard_json) as RemoteQueueGrant)
  }
  const releaseUnspawned = (reservation: ResourceReservation) => {
    const current = budget.getReservation(reservation.id)
    if (current?.state === 'reserved')
      budget.release(reservation.id, { reason: 'spawn_not_started' })
  }
  const drain = async () => {
    const blocked = new Set<string>()
    for (;;) {
      if (closed) return
      const rows = db
        .prepare("SELECT * FROM resource_start_queue WHERE status='queued' ORDER BY sequence")
        .all() as QueueRow[]
      const firstByWorkspace = new Map<string, QueueRow>()
      for (const row of rows)
        if (!firstByWorkspace.has(row.workspace_id)) firstByWorkspace.set(row.workspace_id, row)
      const workspaceIds = [...firstByWorkspace.keys()].sort()
      const cursor = db
        .prepare('SELECT last_workspace_id FROM resource_queue_cursor WHERE id=1')
        .get() as { last_workspace_id: string | null }
      const after =
        cursor.last_workspace_id === null
          ? 0
          : workspaceIds.findIndex((id) => id > String(cursor.last_workspace_id))
      const pivot = after < 0 ? 0 : after
      const order = [...workspaceIds.slice(pivot), ...workspaceIds.slice(0, pivot)]
      let progressed = false
      for (const workspaceId of order) {
        if (closed) return
        const row = firstByWorkspace.get(workspaceId)
        if (!row || blocked.has(row.id)) continue
        const handler = handlers.get(row.source)
        if (!handler) continue
        let reservation: ResourceReservation
        try {
          check(row)
          handler.ready?.(dto(row), JSON.parse(row.payload_json) as Record<string, unknown>)
          reservation = budget.withTransaction(() => {
            const value = budget.reserveInTransaction({
              workspaceId: row.workspace_id,
              executionKey: row.execution_key,
              kind: row.kind,
              agentId: row.agent_id,
            })
            db.prepare(
              "UPDATE resource_start_queue SET status='starting', reason=NULL, reservation_id=?, attempts=attempts+1, updated_at=? WHERE id=? AND status='queued'"
            ).run(value.id, Date.now(), row.id)
            db.prepare('UPDATE resource_queue_cursor SET last_workspace_id=? WHERE id=1').run(
              row.workspace_id
            )
            return value
          })
        } catch (error) {
          if (error instanceof ResourceLimitError || error instanceof ResourceQueueWaitError) {
            db.prepare(
              "UPDATE resource_start_queue SET reason=?,updated_at=? WHERE id=? AND status='queued'"
            ).run(error.reason, Date.now(), row.id)
            continue
          }
          finish(row.id, 'failed', error instanceof Error ? error.message : String(error))
          const failed = get(row.id)
          if (failed?.status === 'failed') await handler.failed?.(dto(failed), error)
          progressed = true
          continue
        }
        progressed = true
        const entry: ResourceQueueWork = {
          ...dto(row),
          status: 'starting',
          attempts: row.attempts + 1,
          reservation_id: reservation.id,
          payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        }
        const guard = row.remote_guard_json
          ? (JSON.parse(row.remote_guard_json) as RemoteQueueGrant)
          : null
        try {
          if (guard) input.auditExecution?.(entry, guard, 'authorized')
          const result = await withRemoteActionCheck(
            () => check(row),
            () => handler.run(entry),
            undefined,
            row.remote_guard_json
              ? (JSON.parse(row.remote_guard_json) as RemoteQueueGrant)
              : undefined
          )
          if (guard) input.auditExecution?.(entry, guard, 'ok')
          if (get(row.id)?.status === 'cancelled') await handler.cancel?.(entry)
          else finish(row.id, 'started', null, result.runId ?? null)
        } catch (error) {
          if (guard) input.auditExecution?.(entry, guard, 'error')
          releaseUnspawned(reservation)
          if (error instanceof ResourceLimitError || error instanceof ResourceQueueWaitError) {
            finish(row.id, 'queued', error.reason)
            blocked.add(row.id)
          } else {
            finish(
              row.id,
              closed ? 'queued' : 'failed',
              closed ? 'runtime_stopped' : error instanceof Error ? error.message : String(error)
            )
            const failed = get(row.id)
            if (failed?.status === 'failed') await handler.failed?.(dto(failed), error)
          }
        }
      }
      if (!progressed) return
    }
  }
  const wake = () => {
    if (closed) return
    if (running) {
      wakeAgain = true
      return
    }
    if (scheduled) return
    scheduled = true
    withoutRemoteActionContext(() =>
      queueMicrotask(() => {
        scheduled = false
        if (closed) return
        running = drain()
          .catch((error) => console.error('[hive] resource queue failed', error))
          .finally(() => {
            running = null
            if (wakeAgain) {
              wakeAgain = false
              wake()
            }
          })
      })
    )
  }
  const unsubscribe = budget.subscribe(wake)
  const waitTimer = setInterval(wake, 2000)
  waitTimer.unref()
  const cancel = (
    id: string,
    options: { pauseAgent?: boolean } = {}
  ): ResourceQueueEntry | null => {
    const row = get(id)
    if (!row) return null
    if (row.status !== 'queued' && row.status !== 'starting') return dto(row)
    handlers.get(row.source)?.assertCancellable?.(dto(row))
    db.prepare(
      "UPDATE resource_start_queue SET status='cancelled',reason='cancelled_by_user',updated_at=? WHERE id=?"
    ).run(Date.now(), id)
    if (row.agent_id && (row.kind === 'worker' || row.kind === 'orchestrator'))
      cancelAgent?.(row.workspace_id, row.agent_id, options.pauseAgent !== false)
    if (row.reservation_id) {
      const reservation = budget.getReservation(row.reservation_id)
      if (reservation) releaseUnspawned(reservation)
    }
    const cancelled = get(id)
    if (!cancelled) throw new Error('Cancelled queue entry disappeared')
    const callback = handlers.get(row.source)?.cancel
    if (callback) {
      const pending = Promise.resolve()
        .then(() => callback(dto(cancelled)))
        .catch((error) => console.error('[hive] queued execution cancellation failed', error))
        .finally(() => pendingCancellations.delete(pending))
      pendingCancellations.add(pending)
    }
    wake()
    return dto(cancelled)
  }
  return {
    enqueue(value: EnqueueResourceStart): ResourceQueueEntry {
      if (closed) throw new ConflictError('The resource queue is closing')
      return budget.withTransaction(() => {
        const existing = db
          .prepare(
            "SELECT * FROM resource_start_queue WHERE workspace_id=? AND execution_key=? AND status IN ('queued','starting')"
          )
          .get(value.workspaceId, value.executionKey) as QueueRow | undefined
        if (existing) return dto(existing)
        const id = randomUUID(),
          time = Date.now(),
          guard = captureRemoteQueueGrant()
        db.prepare(
          "INSERT INTO resource_start_queue(id,workspace_id,agent_id,execution_key,kind,source,payload_json,remote_guard_json,status,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?)"
        ).run(
          id,
          value.workspaceId,
          value.agentId ?? null,
          value.executionKey,
          value.kind,
          value.source,
          JSON.stringify(value.payload),
          guard ? JSON.stringify(guard) : null,
          value.reason ?? 'waiting_for_resources',
          time,
          time
        )
        wake()
        const row = get(id)
        if (!row) throw new Error('Queued start was not persisted')
        return dto(row)
      })
    },
    registerHandler(
      source: ResourceQueueSource,
      handler: QueueHandler,
      options: QueueHandlerOptions = {}
    ) {
      handlers.set(source, { run: handler, ...options })
      wake()
    },
    setAgentCancellation(callback: (workspaceId: string, agentId: string, pause: boolean) => void) {
      cancelAgent = callback
    },
    list(workspaceId?: string): ResourceQueueEntry[] {
      const rows = (
        workspaceId
          ? db
              .prepare('SELECT * FROM resource_start_queue WHERE workspace_id=? ORDER BY sequence')
              .all(workspaceId)
          : db.prepare('SELECT * FROM resource_start_queue ORDER BY sequence').all()
      ) as QueueRow[]
      return rows.map(dto)
    },
    cancel,
    cancelAgent(workspaceId: string, agentId: string) {
      const rows = db
        .prepare(
          "SELECT id FROM resource_start_queue WHERE workspace_id=? AND agent_id=? AND kind IN ('worker','orchestrator') AND status IN ('queued','starting')"
        )
        .all(workspaceId, agentId) as Array<{ id: string }>
      for (const row of rows) cancel(row.id)
    },
    wake,
    async close() {
      closed = true
      clearInterval(waitTimer)
      unsubscribe()
      await running
      while (pendingCancellations.size) await Promise.all(pendingCancellations)
    },
  }
}
export type ResourceStartQueue = ReturnType<typeof createResourceStartQueue>
