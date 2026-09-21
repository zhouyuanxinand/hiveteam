import type { ResourceReservation } from '../shared/resource-budget.js'
import { HttpError } from './http-errors.js'
import type { ResourceBudgetStore } from './resource-budget-store.js'

export class ExecutionCancelledError extends HttpError {
  readonly code = 'execution_cancelled'
  constructor() {
    super(409, 'This pending execution was cancelled before it could start.')
  }
}

/** The resource store is authoritative; this capability only connects a native process to its reservation. */
export const createManagedExecution = (
  resources: ResourceBudgetStore,
  reservation: ResourceReservation,
  signal?: AbortSignal,
  options: { deferRelease?: boolean } = {}
) => {
  let spawnAttempted = false
  let exitEvidence:
    | { run_id: string; pid: number | null; ended_at: number; source: 'native_exit' }
    | undefined
  const releaseConfirmed = (evidence: NonNullable<typeof exitEvidence>) => {
    try {
      resources.release(reservation.id, { reason: 'exit_confirmed', exitEvidence: evidence })
    } catch (error) {
      try {
        resources.markRecoveryBlocked(
          reservation.id,
          'Native exit and cleanup completed; resource release could not be persisted.'
        )
      } catch (markError) {
        throw new AggregateError(
          [error, markError],
          'Resource release and recovery marker could not be persisted.'
        )
      }
      throw error
    }
  }
  return {
    reservationId: reservation.id,
    workspaceId: reservation.workspace_id,
    executionKey: reservation.execution_key,
    signal,
    assertReserved() {
      if (signal?.aborted) throw new ExecutionCancelledError()
      return resources.requireReserved(reservation.id)
    },
    beginSpawn() {
      if (signal?.aborted) throw new ExecutionCancelledError()
      resources.beginSpawn(reservation.id)
      spawnAttempted = true
    },
    markStarted(input: { runId: string; pid: number | null; startedAt: number }) {
      resources.markStarted(reservation.id, input)
    },
    finishPreparation(runId: string, pid: number | null) {
      resources.finishPreparation(reservation.id, {
        run_id: runId,
        pid,
        ended_at: Date.now(),
        source: pid === null ? 'spawn_failed' : 'native_exit',
      })
      spawnAttempted = false
    },
    cancelBeforeSpawn() {
      if (!spawnAttempted) resources.release(reservation.id, { reason: 'spawn_not_started' })
    },
    spawnFailed() {
      if (spawnAttempted)
        resources.release(reservation.id, {
          reason: 'exit_confirmed',
          exitEvidence: { pid: null, ended_at: Date.now(), source: 'spawn_failed' },
        })
      else resources.release(reservation.id, { reason: 'spawn_not_started' })
    },
    confirmExit(runId: string, pid: number | null) {
      const evidence = { run_id: runId, pid, ended_at: Date.now(), source: 'native_exit' as const }
      if (options.deferRelease) exitEvidence = evidence
      else releaseConfirmed(evidence)
    },
    releaseAfterCleanup() {
      if (exitEvidence) releaseConfirmed(exitEvidence)
      else if (!spawnAttempted) resources.release(reservation.id, { reason: 'spawn_not_started' })
    },
    markUnconfirmed(reason: string) {
      resources.markRecoveryBlocked(reservation.id, reason)
    },
  }
}

export type ManagedExecution = ReturnType<typeof createManagedExecution>
