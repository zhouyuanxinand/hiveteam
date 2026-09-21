import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import {
  DEFAULT_DISPATCH_TIMEOUTS,
  type DispatchHealth,
  type DispatchProgress,
  type DispatchTimeouts,
} from '../shared/message-delivery.js'
import { BadRequestError, ConflictError, HttpError } from './http-errors.js'

type HealthRow = Omit<DispatchHealth, 'reasons' | 'timeouts' | 'notification_id'> & {
  reasons: string
  timeouts: string | null
  status: string
  to_agent_id: string
}
export const validateDispatchTimeouts = (value: unknown): DispatchTimeouts => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestError('timeouts must be an object')
  const values = value as Record<string, unknown>
  if (Object.keys(values).some((key) => !Object.hasOwn(DEFAULT_DISPATCH_TIMEOUTS, key)))
    throw new BadRequestError('Unknown timeout setting')
  const result = { ...DEFAULT_DISPATCH_TIMEOUTS, ...values }
  for (const [key, value] of Object.entries(result)) {
    if (key === 'inactivity_ms' && value === null) continue
    const minimum = key === 'delivery_ms' ? 50 : 1000
    const maximum = key === 'delivery_ms' ? 120_000 : 7 * 24 * 60 * 60_000
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum
    )
      throw new BadRequestError(`${key} must be an integer between ${minimum} and ${maximum}`)
  }
  return result as DispatchTimeouts
}
export const createDispatchHealthStore = (db: Database, now = Date.now) => {
  const atomic = <Args extends unknown[], Result>(
    operation: (...args: Args) => Result
  ): ((...args: Args) => Result) => {
    const transaction = db.transaction(operation)
    return (...args) => transaction.immediate(...args)
  }
  const row = (id: string) =>
    db
      .prepare(
        'SELECT h.*,d.status,d.to_agent_id FROM dispatch_health h JOIN dispatches d ON d.id=h.dispatch_id WHERE h.dispatch_id=?'
      )
      .get(id) as HealthRow | undefined
  const event = (id: string, name: string, actor: string, detail: unknown) => {
    const eventId = randomUUID()
    db.prepare('INSERT INTO dispatch_health_events VALUES(?,?,?,?,?,?)').run(
      eventId,
      id,
      now(),
      name,
      actor,
      JSON.stringify(detail)
    )
    return eventId
  }
  const settings = (workspaceId: string) => {
    const saved = db
      .prepare('SELECT settings FROM dispatch_timeout_settings WHERE workspace_id=?')
      .get(workspaceId) as { settings: string } | undefined
    return saved
      ? (JSON.parse(saved.settings) as DispatchTimeouts)
      : { ...DEFAULT_DISPATCH_TIMEOUTS }
  }
  const requireWorker = (workspaceId: string, id: string, workerId: string) => {
    const current = row(id)
    if (!current || current.workspace_id !== workspaceId || current.to_agent_id !== workerId)
      throw new HttpError(404, 'Dispatch not found for this worker')
    return current
  }
  const view = (current: HealthRow): DispatchHealth => {
    const { status: _status, to_agent_id: _agent, ...health } = current
    return {
      ...health,
      notification_id:
        (
          db
            .prepare(
              "SELECT id FROM dispatch_health_events WHERE dispatch_id=? AND event='health_changed' ORDER BY rowid DESC LIMIT 1"
            )
            .get(current.dispatch_id) as { id: string } | undefined
        )?.id ?? null,
      reasons: JSON.parse(current.reasons),
      timeouts: current.timeouts ? JSON.parse(current.timeouts) : settings(current.workspace_id),
    }
  }
  const tick = atomic(() => {
    for (const current of db
      .prepare(
        "SELECT h.*,d.status,d.to_agent_id FROM dispatch_health h JOIN dispatches d ON d.id=h.dispatch_id WHERE d.status IN ('queued','submitted','cancelled')"
      )
      .all() as HealthRow[]) {
      const health = view(current),
        reasons: string[] = []
      if (current.status === 'cancelled') {
        if (
          health.cancellation_requested_at !== null &&
          health.cancellation_confirmed_at === null &&
          now() - health.cancellation_requested_at >= health.timeouts.cancellation_ms
        )
          reasons.push('cancellation_unconfirmed')
      } else if (health.started_at !== null) {
        if (now() - health.started_at >= health.timeouts.execution_ms)
          reasons.push('execution_overdue')
        if (
          !health.waiting_reason &&
          health.timeouts.inactivity_ms !== null &&
          now() - (health.last_progress_at ?? health.started_at) >= health.timeouts.inactivity_ms
        )
          reasons.push('no_progress')
      }
      if (JSON.stringify(reasons) !== current.reasons) {
        db.prepare('UPDATE dispatch_health SET reasons=? WHERE dispatch_id=?').run(
          JSON.stringify(reasons),
          current.dispatch_id
        )
        event(current.dispatch_id, 'health_changed', 'runtime', { reasons })
      }
    }
  })
  return {
    settings,
    event,
    tick,
    get(id: string) {
      const current = row(id)
      return current ? view(current) : undefined
    },
    list(workspaceId: string, workerId?: string) {
      return (
        db
          .prepare(
            `SELECT h.*,d.status,d.to_agent_id FROM dispatch_health h JOIN dispatches d ON d.id=h.dispatch_id WHERE h.workspace_id=? ${workerId ? 'AND d.to_agent_id=?' : ''} ORDER BY d.created_at,d.id`
          )
          .all(...(workerId ? [workspaceId, workerId] : [workspaceId])) as HealthRow[]
      ).map(view)
    },
    configure: atomic(
      (workspaceId: string, settingsInput: unknown, actor: string, dispatchId?: string) => {
        const next = validateDispatchTimeouts(settingsInput)
        if (dispatchId) {
          const current = row(dispatchId)
          if (!current || current.workspace_id !== workspaceId)
            throw new HttpError(404, 'Dispatch not found')
          event(dispatchId, 'timeouts_changed', actor, {
            before: view(current).timeouts,
            after: next,
          })
          db.prepare('UPDATE dispatch_health SET timeouts=? WHERE dispatch_id=?').run(
            JSON.stringify(next),
            dispatchId
          )
        } else {
          // Workspace settings apply to new executions. Existing starts keep their saved settings.
          db.prepare('INSERT INTO dispatch_timeout_events VALUES(?,?,?,?,?,?)').run(
            randomUUID(),
            workspaceId,
            now(),
            actor,
            JSON.stringify(settings(workspaceId)),
            JSON.stringify(next)
          )
          db.prepare(
            'INSERT INTO dispatch_timeout_settings VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET settings=excluded.settings'
          ).run(workspaceId, JSON.stringify(next))
        }
        return next
      }
    ),
    start: atomic((id: string, source: NonNullable<DispatchHealth['start_source']>) => {
      const current = row(id)
      if (!current || current.status === 'cancelled' || current.status === 'reported') return
      if (
        current.started_at !== null &&
        (current.start_source !== 'submission_estimate' || source === 'submission_estimate')
      )
        return
      db.prepare(
        'UPDATE dispatch_health SET started_at=?,start_source=?,last_progress_at=COALESCE(last_progress_at,?),progress_source=COALESCE(progress_source,?),timeouts=COALESCE(timeouts,?) WHERE dispatch_id=?'
      ).run(now(), source, now(), source, JSON.stringify(settings(current.workspace_id)), id)
      event(id, 'execution_start', source, { source })
    }),
    progress: atomic(
      (workspaceId: string, id: string, workerId: string, state: DispatchProgress) => {
        const current = requireWorker(workspaceId, id, workerId)
        if (current.status === 'cancelled' || current.status === 'reported')
          throw new ConflictError('This dispatch is closed')
        db.prepare(
          'UPDATE dispatch_health SET last_progress_at=?,progress_source=?,waiting_reason=? WHERE dispatch_id=?'
        ).run(now(), 'team_status', state === 'progress' ? null : state, id)
        event(id, 'progress', workerId, { state, source: 'team_status' })
      }
    ),
    cancel: atomic((id: string) => {
      const current = row(id)
      if (!current) throw new HttpError(404, 'Dispatch not found')
      db.prepare(
        'UPDATE dispatch_health SET cancellation_requested_at=COALESCE(cancellation_requested_at,?),timeouts=COALESCE(timeouts,?) WHERE dispatch_id=?'
      ).run(now(), JSON.stringify(settings(current.workspace_id)), id)
      event(id, 'cancellation_requested', 'runtime', {})
    }),
    confirmCancellation: atomic(
      (
        workspaceId: string,
        id: string,
        workerId: string,
        source: 'worker_ack' | 'manual',
        actor: string,
        reason?: string
      ) => {
        const current = requireWorker(workspaceId, id, workerId)
        if (current.status !== 'cancelled')
          throw new ConflictError('No cancellation to acknowledge')
        if (current.cancellation_confirmed_at !== null) return
        db.prepare(
          "UPDATE dispatch_health SET cancellation_confirmed_at=?,cancellation_source=?,reasons='[]' WHERE dispatch_id=?"
        ).run(now(), source, id)
        event(id, 'cancellation_confirmed', actor, { source, ...(reason ? { reason } : {}) })
      }
    ),
    complete(id: string) {
      db.prepare(
        "UPDATE dispatch_health SET reasons='[]',waiting_reason=NULL WHERE dispatch_id=?"
      ).run(id)
    },
    lateReport(workspaceId: string, id: string, workerId: string, report: unknown) {
      const current = requireWorker(workspaceId, id, workerId)
      if (current.status !== 'cancelled') throw new ConflictError('Dispatch was not cancelled')
      return event(id, 'late_report', workerId, report)
    },
    events(id: string) {
      return db
        .prepare(
          'SELECT * FROM dispatch_health_events WHERE dispatch_id=? ORDER BY created_at,rowid'
        )
        .all(id)
    },
  }
}
export type DispatchHealthStore = ReturnType<typeof createDispatchHealthStore>
