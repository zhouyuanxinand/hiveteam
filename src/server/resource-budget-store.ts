import { randomUUID } from 'node:crypto'
import {
  type ExecutionKind,
  MAX_RESOURCE_LIMIT,
  type ResourceBudgetSnapshot,
  type ResourceLimits,
  type ResourceReservation,
} from '../shared/resource-budget.js'
import { BadRequestError, HttpError } from './http-errors.js'
import type { Database } from './sqlite.js'

export type ResourceLimitReason =
  | 'global_limit'
  | 'workspace_limit'
  | 'verification_limit'
  | 'worker_limit'
  | 'recovery_pending'

export class ResourceLimitError extends HttpError {
  readonly code = 'resource_limit_reached'

  constructor(
    readonly reason: ResourceLimitReason,
    readonly snapshot: ResourceBudgetSnapshot,
    message?: string
  ) {
    super(
      409,
      message ??
        `Execution admission is blocked: ${reason}. Stop an existing execution or review the resource limits.`
    )
    this.name = 'ResourceLimitError'
  }
}

export class ResourceReservationError extends HttpError {
  readonly code = 'resource_reservation_invalid'

  constructor(message: string) {
    super(409, message)
    this.name = 'ResourceReservationError'
  }
}

export interface ReserveExecutionInput {
  workspaceId: string
  executionKey: string
  kind: ExecutionKind
  agentId?: string | null
}

export interface ExecutionExitEvidence {
  run_id?: string
  pid?: number | null
  ended_at: number
  source: 'native_exit' | 'spawn_failed'
}

export type ProcessPresence = 'absent' | 'alive' | 'unknown'
export type ProcessProbe = (pid: number, reservation: ResourceReservation) => ProcessPresence

const readLimits = (db: Database) =>
  db
    .prepare(`SELECT max_running_total,
  max_running_per_workspace,max_workers_per_workspace,max_verification_per_workspace
  FROM resource_limits WHERE id = 1`)
    .get() as ResourceLimits

const readSnapshot = (db: Database, workspaceId?: string): ResourceBudgetSnapshot => {
  const reservations = db
    .prepare(
      `SELECT * FROM resource_reservations WHERE state != 'released' ORDER BY created_at, id`
    )
    .all() as ResourceReservation[]
  const byWorkspace: Record<string, number> = Object.create(null)
  const byKind: Record<ExecutionKind, number> = {
    orchestrator: 0,
    worker: 0,
    workspace_shell: 0,
    verification: 0,
  }
  for (const row of reservations) {
    byWorkspace[row.workspace_id] = (byWorkspace[row.workspace_id] ?? 0) + 1
    byKind[row.kind] += 1
  }
  return {
    limits: readLimits(db),
    occupancy: { global: reservations.length, by_workspace: byWorkspace, by_kind: byKind },
    reservations: workspaceId
      ? reservations.filter((row) => row.workspace_id === workspaceId)
      : reservations,
  }
}

export const assertWorkerCapacityInTransaction = (
  db: Database,
  workspaceId: string,
  additionalCount: number
) => {
  if (!db.inTransaction)
    throw new ResourceReservationError('Member admission requires a database transaction.')
  if (!Number.isSafeInteger(additionalCount) || additionalCount < 0)
    throw new BadRequestError('Invalid worker count.')
  const count = db
    .prepare('SELECT COUNT(*) AS count FROM workers WHERE workspace_id = ? AND retired_at IS NULL')
    .get(workspaceId) as { count: number }
  const available = Math.max(0, readLimits(db).max_workers_per_workspace - count.count)
  if (additionalCount > available) {
    throw new ResourceLimitError(
      'worker_limit',
      readSnapshot(db),
      `This request needs ${additionalCount} worker slots; ${available} are available. Retire or delete existing members, or raise the worker member limit. Stopping a process does not free a member slot.`
    )
  }
}

const probeProcess: ProcessProbe = (pid) => {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'absent'
    if (code === 'EPERM') return 'unknown'
    throw error
  }
}

export const createResourceBudgetStore = (db: Database, options: { runtimeInstanceId: string }) => {
  const listeners = new Set<() => void>()
  const notify = () =>
    queueMicrotask(() => {
      if (!db.open) return
      for (const listener of listeners) listener()
    })
  const withTransaction = <T>(action: () => T): T =>
    db.inTransaction ? action() : db.transaction(action).immediate()
  const getLimits = () => readLimits(db)
  const getReservation = (id: string) =>
    db.prepare('SELECT * FROM resource_reservations WHERE id = ?').get(id) as
      | ResourceReservation
      | undefined
  const findActive = (workspaceId: string, executionKey: string) =>
    db
      .prepare(
        `SELECT * FROM resource_reservations WHERE workspace_id = ? AND execution_key = ? AND state != 'released'`
      )
      .get(workspaceId, executionKey) as ResourceReservation | undefined
  const getSnapshot = (workspaceId?: string): ResourceBudgetSnapshot =>
    withTransaction(() => readSnapshot(db, workspaceId))
  const required = (id: string) => {
    const row = getReservation(id)
    if (!row) throw new ResourceReservationError('Unknown execution reservation.')
    return row
  }
  const requireOwner = (row: ResourceReservation) => {
    if (row.runtime_instance_id !== options.runtimeInstanceId) {
      throw new ResourceReservationError(
        'The execution reservation belongs to another runtime instance.'
      )
    }
  }
  const requireReserved = (id: string) => {
    const row = required(id)
    requireOwner(row)
    if (row.state !== 'reserved')
      throw new ResourceReservationError('A fresh reserved execution is required before spawning.')
    return row
  }
  const insertReservation = (
    input: ReserveExecutionInput,
    runtimeInstanceId: string,
    state: ResourceReservation['state'],
    metadata: { runId?: string; pid?: number | null; reason?: string; startedAt?: number } = {}
  ) => {
    const id = randomUUID()
    const now = Date.now()
    db.prepare(`INSERT INTO resource_reservations
      (id,runtime_instance_id,workspace_id,execution_key,kind,state,agent_id,run_id,pid,reason,created_at,updated_at,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      runtimeInstanceId,
      input.workspaceId,
      input.executionKey,
      input.kind,
      state,
      input.agentId ?? null,
      metadata.runId ?? null,
      metadata.pid ?? null,
      metadata.reason ?? null,
      now,
      now,
      metadata.startedAt ?? null
    )
    return required(id)
  }
  const reserveInTransaction = (input: ReserveExecutionInput) => {
    if (!db.inTransaction)
      throw new ResourceReservationError('Admission requires a database transaction.')
    if (
      !input.workspaceId ||
      !input.executionKey ||
      !['orchestrator', 'worker', 'workspace_shell', 'verification'].includes(input.kind)
    ) {
      throw new BadRequestError('Invalid execution reservation identity.')
    }
    const existing =
      findActive(input.workspaceId, input.executionKey) ??
      (input.agentId && (input.kind === 'worker' || input.kind === 'orchestrator')
        ? (db
            .prepare(
              `SELECT * FROM resource_reservations WHERE workspace_id = ? AND agent_id = ? AND kind IN ('worker', 'orchestrator') AND state != 'released' ORDER BY created_at LIMIT 1`
            )
            .get(input.workspaceId, input.agentId) as ResourceReservation | undefined)
        : undefined)
    if (existing) {
      if (
        existing.runtime_instance_id !== options.runtimeInstanceId ||
        existing.state === 'recovery_blocked'
      ) {
        throw new ResourceLimitError('recovery_pending', getSnapshot())
      }
      if (existing.kind !== input.kind || existing.agent_id !== (input.agentId ?? null)) {
        throw new ResourceReservationError(
          'The execution key already belongs to another execution.'
        )
      }
      return existing
    }
    const snapshot = getSnapshot()
    if (snapshot.occupancy.global >= snapshot.limits.max_running_total)
      throw new ResourceLimitError('global_limit', snapshot)
    if (
      (snapshot.occupancy.by_workspace[input.workspaceId] ?? 0) >=
      snapshot.limits.max_running_per_workspace
    )
      throw new ResourceLimitError('workspace_limit', snapshot)
    if (
      input.kind === 'verification' &&
      snapshot.reservations.filter(
        (row) => row.workspace_id === input.workspaceId && row.kind === 'verification'
      ).length >= snapshot.limits.max_verification_per_workspace
    ) {
      throw new ResourceLimitError('verification_limit', snapshot)
    }
    return insertReservation(input, options.runtimeInstanceId, 'reserved')
  }
  const reserve = (input: ReserveExecutionInput) =>
    withTransaction(() => reserveInTransaction(input))
  const beginSpawn = (id: string) =>
    withTransaction(() => {
      requireReserved(id)
      db.prepare(
        `UPDATE resource_reservations SET state = 'spawn_pending', updated_at = ? WHERE id = ?`
      ).run(Date.now(), id)
      return required(id)
    })
  const markStarted = (
    id: string,
    input: { runId?: string; pid?: number | null; startedAt?: number; processIdentity?: string }
  ) =>
    withTransaction(() => {
      const row = required(id)
      requireOwner(row)
      if (input.pid != null && (!Number.isSafeInteger(input.pid) || input.pid <= 0))
        throw new BadRequestError('A process ID must be a positive integer.')
      if (
        !['spawn_pending', 'running'].includes(row.state) &&
        !(row.state === 'released' && row.reason === 'exit_confirmed')
      ) {
        throw new ResourceReservationError('This execution is not awaiting process registration.')
      }
      if (
        (row.run_id && row.run_id !== input.runId) ||
        (row.pid !== null && row.pid !== input.pid)
      ) {
        throw new ResourceReservationError('The registered process identity changed.')
      }
      db.prepare(
        `UPDATE resource_reservations SET state = ?, run_id = ?, pid = ?, process_identity = ?, started_at = ?, updated_at = ? WHERE id = ?`
      ).run(
        row.state === 'released' ? 'released' : 'running',
        input.runId ?? null,
        input.pid ?? null,
        input.processIdentity ?? null,
        input.startedAt ?? Date.now(),
        Date.now(),
        id
      )
      return required(id)
    })
  const markRecoveryBlocked = (id: string, reason = 'exit_unconfirmed') =>
    withTransaction(() => {
      const row = required(id)
      if (row.state === 'released') return row
      db.prepare(
        `UPDATE resource_reservations SET state = 'recovery_blocked', reason = ?, updated_at = ? WHERE id = ?`
      ).run(reason, Date.now(), id)
      return required(id)
    })
  const release = (
    id: string,
    input: { reason: 'spawn_not_started' | 'exit_confirmed'; exitEvidence?: ExecutionExitEvidence }
  ) => {
    const result = withTransaction(() => {
      const row = required(id)
      requireOwner(row)
      if (row.state === 'released') return row
      if (input.reason === 'spawn_not_started') {
        if (row.state !== 'reserved')
          throw new ResourceReservationError(
            'A possibly spawned process cannot be released without exit confirmation.'
          )
      } else {
        const evidence = input.exitEvidence
        if (
          !evidence ||
          !Number.isSafeInteger(evidence.ended_at) ||
          evidence.ended_at <= 0 ||
          !['native_exit', 'spawn_failed'].includes(evidence.source)
        ) {
          throw new ResourceReservationError('Native process exit evidence is required.')
        }
        if (
          (row.pid !== null && row.pid !== evidence.pid) ||
          (row.run_id && row.run_id !== evidence.run_id) ||
          (evidence.source === 'spawn_failed' && (row.pid !== null || evidence.pid != null))
        ) {
          throw new ResourceReservationError('Exit evidence does not match this process.')
        }
      }
      const now = Date.now()
      db.prepare(
        `UPDATE resource_reservations SET state = 'released', reason = ?, released_at = ?, updated_at = ? WHERE id = ?`
      ).run(input.reason, now, now, id)
      return required(id)
    })
    notify()
    return result
  }
  const recover = (input: { probe?: ProcessProbe } = {}) => {
    const recovered = withTransaction(() => {
      const rows = db
        .prepare(
          `SELECT * FROM resource_reservations WHERE state != 'released'
           AND (runtime_instance_id != ? OR state = 'recovery_blocked')`
        )
        .all(options.runtimeInstanceId) as ResourceReservation[]
      for (const row of rows) {
        const presence = row.pid === null ? 'unknown' : (input.probe ?? probeProcess)(row.pid, row)
        // Current running executions can still own native handles or verification
        // cleanup after their PID exits. Only an explicit recovery block permits
        // probing them here; their normal lifecycle remains the release authority.
        const neverSpawned =
          row.runtime_instance_id !== options.runtimeInstanceId && row.state === 'reserved'
        const safe = neverSpawned || presence === 'absent'
        const reason = neverSpawned
          ? 'never_spawned'
          : presence === 'absent'
            ? 'process_absent'
            : row.pid === null
              ? 'unknown_process_identity'
              : presence === 'alive'
                ? 'process_still_present'
                : 'process_liveness_unknown'
        const now = Date.now()
        db.prepare(
          `UPDATE resource_reservations SET state = ?, reason = ?, released_at = ?, updated_at = ? WHERE id = ?`
        ).run(safe ? 'released' : 'recovery_blocked', reason, safe ? now : null, now, row.id)
      }
      return rows.map((row) => required(row.id))
    })
    notify()
    return recovered
  }
  const adoptLegacyExecution = (
    input: ReserveExecutionInput & { runId: string; pid: number | null; startedAt: number }
  ) =>
    withTransaction(() => {
      const existing = db
        .prepare('SELECT * FROM resource_reservations WHERE run_id = ? LIMIT 1')
        .get(input.runId) as ResourceReservation | undefined
      if (existing) return existing
      const key = findActive(input.workspaceId, input.executionKey)
        ? `legacy:${input.runId}`
        : input.executionKey
      return insertReservation({ ...input, executionKey: key }, randomUUID(), 'recovery_blocked', {
        runId: input.runId,
        pid: input.pid,
        startedAt: input.startedAt,
        reason: 'legacy_process_unverified',
      })
    })
  const updateLimits = (patch: Partial<ResourceLimits>, input: { actor: 'local_user' }) => {
    if (input.actor !== 'local_user')
      throw new BadRequestError('Only local user resource changes can be recorded.')
    const result = withTransaction(() => {
      const before = getLimits()
      for (const [key, value] of Object.entries(patch)) {
        if (
          !Object.hasOwn(before, key) ||
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > MAX_RESOURCE_LIMIT
        ) {
          throw new BadRequestError(
            `Resource limits must be integers from 1 through ${MAX_RESOURCE_LIMIT}.`
          )
        }
      }
      const after = { ...before, ...patch }
      db.prepare(
        `UPDATE resource_limits SET max_running_total = ?, max_running_per_workspace = ?, max_workers_per_workspace = ?, max_verification_per_workspace = ? WHERE id = 1`
      ).run(
        after.max_running_total,
        after.max_running_per_workspace,
        after.max_workers_per_workspace,
        after.max_verification_per_workspace
      )
      db.prepare(
        `INSERT INTO resource_limit_audit(id,actor,before_json,after_json,created_at) VALUES(?,?,?,?,?)`
      ).run(randomUUID(), input.actor, JSON.stringify(before), JSON.stringify(after), Date.now())
      return after
    })
    notify()
    return result
  }
  return {
    runtimeInstanceId: options.runtimeInstanceId,
    withTransaction,
    getLimits,
    getSnapshot,
    getReservation,
    findActive,
    requireReserved,
    reserve,
    reserveInTransaction,
    beginSpawn,
    markStarted,
    markRecoveryBlocked,
    finishPreparation: (id: string, evidence: ExecutionExitEvidence) =>
      withTransaction(() => {
        const row = required(id)
        requireOwner(row)
        if (
          !['spawn_pending', 'running'].includes(row.state) ||
          !Number.isSafeInteger(evidence.ended_at) ||
          evidence.ended_at <= 0 ||
          (row.pid !== null && row.pid !== evidence.pid) ||
          (row.run_id && row.run_id !== evidence.run_id) ||
          !['native_exit', 'spawn_failed'].includes(evidence.source) ||
          (evidence.source === 'spawn_failed' && (row.pid !== null || evidence.pid != null))
        )
          throw new ResourceReservationError(
            'Preparation exit evidence does not match this execution.'
          )
        // Keep the slot throughout preparation and the following PTY launch; helpers never overlap.
        db.prepare(
          "UPDATE resource_reservations SET state='reserved',run_id=NULL,pid=NULL,process_identity=NULL,started_at=NULL,updated_at=? WHERE id=?"
        ).run(Date.now(), id)
        return required(id)
      }),
    release,
    recover,
    adoptLegacyExecution,
    updateLimits,
    assertWorkerCapacityInTransaction: (workspaceId: string, additionalCount: number) =>
      assertWorkerCapacityInTransaction(db, workspaceId, additionalCount),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type ResourceBudgetStore = ReturnType<typeof createResourceBudgetStore>
