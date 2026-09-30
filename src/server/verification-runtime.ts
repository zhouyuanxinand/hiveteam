import { randomUUID } from 'node:crypto'
import type { ResourceReservation } from '../shared/resource-budget.js'
import type { DispatchVerification, DispatchVerificationView } from '../shared/verification.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { BadRequestError, ConflictError, HttpError } from './http-errors.js'
import { createManagedExecution, type ManagedExecution } from './managed-execution.js'
import { recheckRemoteAction } from './remote-action-context.js'
import {
  type ResourceBudgetStore,
  ResourceLimitError,
  ResourceReservationError,
} from './resource-budget-store.js'
import { ResourceQueueWaitError, type ResourceStartQueue } from './resource-start-queue.js'
import type { Database } from './sqlite.js'
import { createVerificationExecutor } from './verification-executor.js'
import { createVerificationLogs } from './verification-logs.js'
import { createVerificationProfiles, legacyVerificationProfile } from './verification-profiles.js'
import { createVerificationStore } from './verification-store.js'
import { readVerificationVersion } from './verification-worktree.js'

const reportIsReady = (dispatch: DispatchRecord) =>
  dispatch.status === 'reported' &&
  (dispatch.reportOutcome === 'success' || dispatch.reportOutcome === null)
type VerificationRequest = {
  command: string
  headSha: string
  reportRevision: number
  profileId?: string
  subject?: DispatchVerification['subject']
}

export const createVerificationRuntime = (input: {
  db: Database
  dataDir: string | null
  resources: ResourceBudgetStore
  resourceQueue: ResourceStartQueue
  assertWorkspaceWritable?: (workspaceId: string) => void
  getWorkspacePath: (workspaceId: string, dispatchId: string) => string
  isIsolated?: (workspaceId: string, dispatchId: string) => boolean
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  acceptReport: (workspaceId: string, dispatchId: string, revision: number) => DispatchRecord
  onAccepted: (workspaceId: string, dispatch: DispatchRecord) => void
  onChanged?: (workspaceId: string, dispatchId: string) => void
}) => {
  const store = createVerificationStore(input.db)
  const profiles = createVerificationProfiles(input.db)
  const logs = createVerificationLogs(input.dataDir)
  let candidateSource: ((run: DispatchVerification) => Promise<string>) | undefined
  const sourcePath = (run: DispatchVerification) =>
    run.subject
      ? (candidateSource?.(run) ??
        Promise.reject(new ConflictError('Integration candidate is unavailable.')))
      : Promise.resolve(input.getWorkspacePath(run.workspaceId, run.dispatchId))
  store.interruptUnfinished()
  type Pending = {
    workspaceId: string
    dispatchId: string
    subjectKey: string
    profileId: string
    workerId: string
    abort: AbortController
    execution: ManagedExecution
    done: Promise<DispatchVerification>
  }
  const preparing = new Map<string, Pending>()
  const active = new Map<string, Omit<Pending, 'done'> & { done: Promise<void> }>()
  const removedWorkspaces = new Set<string>()
  let closing = false
  const busy = (workspaceId: string, dispatchId: string) =>
    [...preparing.values(), ...active.values()].some(
      (run) => run.workspaceId === workspaceId && run.dispatchId === dispatchId
    )
  const getDispatch = (workspaceId: string, dispatchId: string) => {
    const dispatch = input.getDispatch(workspaceId, dispatchId)
    if (!dispatch) throw new HttpError(404, 'Dispatch not found')
    return dispatch
  }
  const assertOpen = (workspaceId: string) => {
    if (closing || removedWorkspaces.has(workspaceId))
      throw new ConflictError('The verification runtime is closing.')
  }
  const view = async (
    workspaceId: string,
    dispatchId: string
  ): Promise<DispatchVerificationView> => {
    const version = await readVerificationVersion(input.getWorkspacePath(workspaceId, dispatchId))
    const dispatch = getDispatch(workspaceId, dispatchId)
    const runs = store.list(workspaceId, dispatchId)
    const latest = runs[0]
    const staleReason = latest
      ? !reportIsReady(dispatch) || latest.reportRevision !== dispatch.reportRevision
        ? 'report_changed'
        : latest.headSha !== version.headSha
          ? 'code_changed'
          : version.isDirty
            ? 'uncommitted_changes'
            : null
      : null
    const current = !version.unavailableReason && staleReason === null
    return {
      isolated: input.isIsolated?.(workspaceId, dispatchId) ?? false,
      headSha: version.headSha,
      isDirty: version.isDirty,
      unavailableReason: version.unavailableReason,
      reportRevision: dispatch.reportRevision,
      canRun:
        !closing &&
        !!version.headSha &&
        !version.isDirty &&
        !version.unavailableReason &&
        reportIsReady(dispatch) &&
        latest?.state !== 'queued' &&
        latest?.state !== 'running',
      canAccept:
        current &&
        latest?.state === 'passed' &&
        latest.acceptedAt === null &&
        !busy(workspaceId, dispatchId),
      staleReason,
      accepted: current && latest?.state === 'passed' && latest.acceptedAt != null,
      runs,
    }
  }
  const execute = createVerificationExecutor({
    dataDir: input.dataDir,
    store,
    logs,
    onChanged: input.onChanged,
  })
  const launch = (
    initial: DispatchVerification,
    reservation: ResourceReservation,
    persisted: boolean
  ) => {
    const abort = new AbortController()
    const execution = createManagedExecution(input.resources, reservation, abort.signal, {
      deferRelease: true,
    })
    const dispatch = getDispatch(initial.workspaceId, initial.dispatchId)
    const done = (async () => {
      try {
        assertOpen(initial.workspaceId)
        execution.assertReserved()
        recheckRemoteAction()
        const source = await sourcePath(initial)
        const version = await readVerificationVersion(source)
        const current = getDispatch(initial.workspaceId, initial.dispatchId)
        assertOpen(initial.workspaceId)
        execution.assertReserved()
        recheckRemoteAction()
        input.assertWorkspaceWritable?.(initial.workspaceId)
        if (
          store
            .list(initial.workspaceId, initial.dispatchId, initial.subject?.candidate_id)
            .some((other) => other.id !== initial.id && other.state === 'running')
        )
          throw new ConflictError('Another verification of this subject has already started.')
        if (!reportIsReady(current) || current.reportRevision !== initial.reportRevision)
          throw new ConflictError('The report changed. Refresh and review it again.')
        if (
          !version.repoRoot ||
          !version.headSha ||
          version.unavailableReason ||
          version.isDirty ||
          version.headSha !== initial.headSha
        )
          throw new ConflictError(
            'Commit all changes and refresh the current Git version before verification.'
          )
        const run: DispatchVerification = { ...initial, state: 'running' }
        if (persisted) store.save(run)
        else store.insert(run)
        const finished = execute(run, source, abort, execution).finally(() => {
          active.delete(run.id)
          execution.releaseAfterCleanup()
        })
        active.set(run.id, {
          workspaceId: run.workspaceId,
          dispatchId: run.dispatchId,
          subjectKey: run.subject?.candidate_id ?? '',
          profileId: run.profile?.id ?? 'legacy-command',
          workerId: dispatch.toAgentId,
          abort,
          execution,
          done: finished,
        })
        void finished.catch((error: unknown) =>
          console.error('[hiveteam] verification persistence failed', error)
        )
        return run
      } catch (error) {
        if (persisted && !closing && store.get(initial.id)?.state === 'queued')
          store.save({
            ...initial,
            state: abort.signal.aborted ? 'cancelled' : 'failed',
            endedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          })
        throw error
      } finally {
        if (!active.has(initial.id)) execution.cancelBeforeSpawn()
      }
    })().finally(() => preparing.delete(initial.id))
    preparing.set(initial.id, {
      workspaceId: initial.workspaceId,
      dispatchId: initial.dispatchId,
      subjectKey: initial.subject?.candidate_id ?? '',
      profileId: initial.profile?.id ?? 'legacy-command',
      workerId: dispatch.toAgentId,
      abort,
      execution,
      done,
    })
    return done
  }
  const prerequisites = (run: DispatchVerification) => {
    if (!input.resources)
      throw new ResourceReservationError('Execution admission is required for verification.')
    const profile = run.profile ?? legacyVerificationProfile(run.command)
    if (
      [...preparing, ...active].some(
        ([id, other]) =>
          id !== run.id &&
          other.workspaceId === run.workspaceId &&
          other.dispatchId === run.dispatchId &&
          other.subjectKey === (run.subject?.candidate_id ?? '')
      )
    )
      throw new ResourceQueueWaitError('verification_subject_busy')
    const missing = profile.required_env.filter((name) => !process.env[name])
    if (missing.length)
      throw new ResourceQueueWaitError(`verification_environment_required: ${missing.join(', ')}`)
    const running = input.db
      .prepare(
        "SELECT COUNT(*) AS n FROM dispatch_verifications WHERE workspace_id=? AND state='running' AND COALESCE(json_extract(profile_json,'$.id'),'legacy-command')=?"
      )
      .get(run.workspaceId, profile.id) as { n: number }
    const pending = [...preparing].filter(
      ([id, item]) =>
        id !== run.id &&
        item.workspaceId === run.workspaceId &&
        item.profileId === profile.id &&
        store.get(id)?.state !== 'running'
    ).length
    if (running.n + pending >= profile.max_parallel)
      throw new ResourceQueueWaitError('verification_profile_concurrency_limit')
  }
  const reserve = (run: DispatchVerification) => {
    prerequisites(run)
    return input.resources.reserve({
      workspaceId: run.workspaceId,
      executionKey: `verification:${run.id}`,
      agentId: getDispatch(run.workspaceId, run.dispatchId).toAgentId,
      kind: 'verification',
    })
  }
  const cancelRun = async (id: string) => {
    const pending = preparing.get(id)
    if (pending) {
      pending.abort.abort()
      pending.execution.cancelBeforeSpawn()
      await Promise.allSettled([pending.done])
    }
    const running = active.get(id)
    if (running) {
      running.abort.abort()
      await running.done
    }
    const stored = store.get(id)
    if (!closing && stored?.state === 'queued')
      store.save({ ...stored, state: 'cancelled', endedAt: Date.now() })
  }
  input.resourceQueue.registerHandler(
    'verification',
    async (entry) => {
      const id = entry.execution_key.slice('verification:'.length)
      const run = store.get(id)
      if (!run || run.workspaceId !== entry.workspace_id || run.state !== 'queued')
        throw new ConflictError('The queued verification is no longer available.')
      await launch(run, reserve(run), true)
      return { runId: id }
    },
    {
      ready: (entry) => {
        const run = store.get(entry.execution_key.slice('verification:'.length))
        if (!run || run.state !== 'queued')
          throw new ConflictError('Verification is no longer queued.')
        prerequisites(run)
      },
      cancel: (entry) => cancelRun(entry.execution_key.slice('verification:'.length)),
      failed: (entry, error) => {
        const run = store.get(entry.execution_key.slice('verification:'.length))
        if (run?.state === 'queued')
          store.save({
            ...run,
            state: 'failed',
            endedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          })
      },
    }
  )
  const start = async (workspaceId: string, dispatchId: string, request: VerificationRequest) => {
    assertOpen(workspaceId)
    input.assertWorkspaceWritable?.(workspaceId)
    const profile = request.profileId
      ? profiles.get(workspaceId, request.profileId)
      : legacyVerificationProfile(request.command)
    if (!profile.command.trim() || profile.command.length > 2000 || profile.command.includes('\0'))
      throw new BadRequestError(
        'command must contain between 1 and 2000 characters without NUL bytes'
      )
    const dispatch = getDispatch(workspaceId, dispatchId)
    if (!reportIsReady(dispatch) || dispatch.reportRevision !== request.reportRevision)
      throw new ConflictError('The report changed. Refresh and review it again.')
    const duplicate = store
      .list(workspaceId, dispatchId, request.subject?.candidate_id)
      .find(
        (run) =>
          (run.state === 'queued' || run.state === 'running') &&
          run.command === profile.command.trim() &&
          JSON.stringify(run.profile) === JSON.stringify(profile) &&
          run.headSha === request.headSha &&
          run.reportRevision === request.reportRevision
      )
    if (duplicate) return duplicate
    const run: DispatchVerification = {
      id: randomUUID(),
      workspaceId,
      dispatchId,
      reportRevision: request.reportRevision,
      headSha: request.headSha,
      command: profile.command.trim(),
      profile,
      ...(request.subject ? { subject: request.subject } : {}),
      state: 'queued',
      output: '',
      outputTruncated: false,
      exitCode: null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
      acceptedAt: null,
    }
    let reservation: ResourceReservation
    try {
      reservation = reserve(run)
    } catch (error) {
      if (!(error instanceof ResourceLimitError) && !(error instanceof ResourceQueueWaitError))
        throw error
      input.db.transaction(() => {
        store.insert(run)
        input.resourceQueue.enqueue({
          workspaceId,
          agentId: dispatch.toAgentId,
          executionKey: `verification:${run.id}`,
          kind: 'verification',
          source: 'verification',
          payload: { verification_id: run.id },
          reason: error.reason,
        })
      })()
      return run
    }
    return launch(run, reservation, false)
  }
  const cancelWorkspace = async (workspaceId: string, cancelQueued: boolean) => {
    if (cancelQueued)
      for (const entry of input.resourceQueue.list(workspaceId))
        if (
          entry.source === 'verification' &&
          (entry.status === 'queued' || entry.status === 'starting')
        )
          input.resourceQueue.cancel(entry.id)
    const ids = new Set(
      [...preparing, ...active]
        .filter(([, run]) => run.workspaceId === workspaceId)
        .map(([id]) => id)
    )
    await Promise.all([...ids].map(cancelRun))
  }
  return {
    profiles,
    get: store.get,
    listCandidate: (workspaceId: string, dispatchId: string, candidateId: string) =>
      store.list(workspaceId, dispatchId, candidateId),
    setCandidateSource(reader: NonNullable<typeof candidateSource>) {
      candidateSource = reader
    },
    readLog(workspaceId: string, dispatchId: string, id: string, offset?: number, limit?: number) {
      const run = store.get(id)
      if (!run || run.workspaceId !== workspaceId || run.dispatchId !== dispatchId)
        throw new HttpError(404, 'Verification not found')
      return logs.read(id, offset, limit)
    },
    view,
    start,
    async accept(workspaceId: string, dispatchId: string, verificationId: string) {
      input.assertWorkspaceWritable?.(workspaceId)
      const current = await view(workspaceId, dispatchId)
      const latest = current.runs[0]
      if (!latest || latest.id !== verificationId || (!current.canAccept && !current.accepted))
        throw new ConflictError(
          'Verification is stale, unfinished, or failed. Review the current version and verify again.'
        )
      const dispatch = input.db.transaction(() => {
        input.assertWorkspaceWritable?.(workspaceId)
        if (
          busy(workspaceId, dispatchId) ||
          store.list(workspaceId, dispatchId)[0]?.id !== latest.id
        )
          throw new ConflictError('A newer verification has started. Wait for its result.')
        const accepted = input.acceptReport(workspaceId, dispatchId, latest.reportRevision)
        store.accept(latest.id)
        return accepted
      })()
      input.onAccepted(workspaceId, dispatch)
      return view(workspaceId, dispatchId)
    },
    async cancel(workspaceId: string, dispatchId: string, verificationId: string) {
      getDispatch(workspaceId, dispatchId)
      const run = store.get(verificationId)
      if (
        !run ||
        run.workspaceId !== workspaceId ||
        run.dispatchId !== dispatchId ||
        !['queued', 'running'].includes(run.state)
      )
        throw new ConflictError('This verification is no longer running or queued.')
      const entry = input.resourceQueue
        .list(workspaceId)
        .find(
          (item) =>
            item.execution_key === `verification:${verificationId}` &&
            (item.status === 'queued' || item.status === 'starting')
        )
      if (entry) input.resourceQueue.cancel(entry.id)
      await cancelRun(verificationId)
      return view(workspaceId, dispatchId)
    },
    async deleteWorkspace(workspaceId: string) {
      removedWorkspaces.add(workspaceId)
      await cancelWorkspace(workspaceId, true)
    },
    assertWorkerIdle(workspaceId: string, workerId: string) {
      if (
        [...active.values(), ...preparing.values()].some(
          (run) => run.workspaceId === workspaceId && run.workerId === workerId
        ) ||
        input.resourceQueue
          .list(workspaceId)
          .some(
            (entry) =>
              entry.kind === 'verification' &&
              entry.agent_id === workerId &&
              (entry.status === 'queued' || entry.status === 'starting')
          )
      )
        throw new ConflictError(
          'Cancel the active or queued verification before deleting this worker.'
        )
    },
    async close() {
      closing = true
      const workspaces = new Set(
        [...preparing.values(), ...active.values()].map((run) => run.workspaceId)
      )
      await Promise.all([...workspaces].map((id) => cancelWorkspace(id, false)))
    },
  }
}

export type VerificationRuntime = ReturnType<typeof createVerificationRuntime>
