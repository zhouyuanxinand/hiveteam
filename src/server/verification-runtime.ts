import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { DispatchVerification, DispatchVerificationView } from '../shared/verification.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { BadRequestError, ConflictError, HttpError } from './http-errors.js'
import { runVerificationCommand } from './verification-process.js'
import { createVerificationStore } from './verification-store.js'
import { readVerificationVersion, withVerificationWorktree } from './verification-worktree.js'

const OUTPUT_LIMIT = 64 * 1024
const reportIsReady = (dispatch: DispatchRecord) =>
  dispatch.status === 'reported' &&
  (dispatch.reportOutcome === 'success' || dispatch.reportOutcome === null)

export const createVerificationRuntime = (input: {
  db: Database
  dataDir: string | null
  getWorkspacePath: (workspaceId: string) => string
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  acceptReport: (workspaceId: string, dispatchId: string, revision: number) => DispatchRecord
  onAccepted: (workspaceId: string, dispatch: DispatchRecord) => void
}) => {
  const store = createVerificationStore(input.db)
  store.interruptUnfinished()
  const active = new Map<
    string,
    {
      id: string
      dispatchId: string
      workerId: string
      abort: AbortController
      done: Promise<void>
    }
  >()
  const starting = new Set<string>()
  const removedWorkspaces = new Set<string>()
  const pendingStarts = new Set<Promise<DispatchVerification>>()
  let closing = false
  const getDispatch = (workspaceId: string, dispatchId: string) => {
    const dispatch = input.getDispatch(workspaceId, dispatchId)
    if (!dispatch) throw new HttpError(404, 'Dispatch not found')
    return dispatch
  }
  const view = async (
    workspaceId: string,
    dispatchId: string
  ): Promise<DispatchVerificationView> => {
    const version = await readVerificationVersion(input.getWorkspacePath(workspaceId))
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
        !active.has(workspaceId) &&
        !starting.has(workspaceId),
      canAccept:
        current &&
        latest?.state === 'passed' &&
        latest.acceptedAt === null &&
        !active.has(workspaceId) &&
        !starting.has(workspaceId),
      staleReason,
      accepted: current && latest?.state === 'passed' && latest.acceptedAt != null,
      runs,
    }
  }
  const execute = async (
    initial: DispatchVerification,
    repoRoot: string,
    relativePath: string | null,
    abort: AbortController
  ) => {
    let run = initial
    const save = (patch: Partial<DispatchVerification>) => {
      const next = { ...run, ...patch }
      store.save(next)
      run = next
    }
    let output = ''
    let truncated = false
    let lastSaved = 0
    try {
      const result = await withVerificationWorktree({
        dataDir: input.dataDir,
        repoRoot,
        relativePath,
        headSha: run.headSha,
        run: async (cwd, checkout) => {
          if (abort.signal.aborted) return { exitCode: null, changed: false }
          const exitCode = await runVerificationCommand({
            cwd,
            command: run.command,
            signal: abort.signal,
            onOutput: (text) => {
              if (output.length + text.length > OUTPUT_LIMIT) truncated = true
              output += text.slice(0, OUTPUT_LIMIT - output.length)
              if (Date.now() - lastSaved >= 250) {
                save({ output, outputTruncated: truncated })
                lastSaved = Date.now()
              }
            },
          })
          save({ exitCode })
          const after = await readVerificationVersion(checkout)
          return {
            exitCode,
            changed: after.headSha !== run.headSha || after.isDirty || !!after.unavailableReason,
          }
        },
      })
      save({
        state: abort.signal.aborted
          ? 'cancelled'
          : result.exitCode === 0 && !result.changed
            ? 'passed'
            : 'failed',
        exitCode: result.exitCode,
        error: result.changed
          ? 'The verification command changed checkout files or HEAD. Commit the intended changes and verify again.'
          : null,
        output,
        outputTruncated: truncated,
        endedAt: Date.now(),
      })
    } catch (error) {
      save({
        state: abort.signal.aborted ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : String(error),
        output,
        outputTruncated: truncated,
        endedAt: Date.now(),
      })
    }
  }
  const startRun = async (
    workspaceId: string,
    dispatchId: string,
    request: { command: string; headSha: string; reportRevision: number }
  ) => {
    if (
      closing ||
      removedWorkspaces.has(workspaceId) ||
      active.has(workspaceId) ||
      starting.has(workspaceId)
    )
      throw new ConflictError('A verification is already running or the runtime is closing.')
    if (!request.command.trim() || request.command.length > 2000 || request.command.includes('\0'))
      throw new BadRequestError(
        'command must contain between 1 and 2000 characters without NUL bytes'
      )
    starting.add(workspaceId)
    try {
      const version = await readVerificationVersion(input.getWorkspacePath(workspaceId))
      const dispatch = getDispatch(workspaceId, dispatchId)
      if (
        closing ||
        removedWorkspaces.has(workspaceId) ||
        !reportIsReady(dispatch) ||
        dispatch.reportRevision !== request.reportRevision
      )
        throw new ConflictError('The report changed. Refresh and review it again.')
      if (
        !version.repoRoot ||
        !version.headSha ||
        version.unavailableReason ||
        version.isDirty ||
        version.headSha !== request.headSha
      )
        throw new ConflictError(
          'Commit all changes and refresh the current Git version before verification.'
        )
      const run: DispatchVerification = {
        id: randomUUID(),
        workspaceId,
        dispatchId,
        reportRevision: request.reportRevision,
        headSha: version.headSha,
        command: request.command.trim(),
        state: 'running',
        output: '',
        outputTruncated: false,
        exitCode: null,
        error: null,
        startedAt: Date.now(),
        endedAt: null,
        acceptedAt: null,
      }
      store.insert(run)
      const abort = new AbortController()
      const done = execute(run, version.repoRoot, version.relativePath, abort).finally(() =>
        active.delete(workspaceId)
      )
      active.set(workspaceId, { id: run.id, dispatchId, workerId: dispatch.toAgentId, abort, done })
      // Keep failures observable even if the initiating browser disconnects.
      void done.catch((error: unknown) =>
        console.error('[hive] verification persistence failed', error)
      )
      return run
    } finally {
      starting.delete(workspaceId)
    }
  }
  const cancelWorkspace = async (workspaceId: string) => {
    const running = active.get(workspaceId)
    if (running) {
      running.abort.abort()
      await running.done
    }
  }
  return {
    view,
    start(
      workspaceId: string,
      dispatchId: string,
      request: { command: string; headSha: string; reportRevision: number }
    ) {
      const promise = startRun(workspaceId, dispatchId, request)
      pendingStarts.add(promise)
      void promise.then(
        () => pendingStarts.delete(promise),
        () => pendingStarts.delete(promise)
      )
      return promise
    },
    async accept(workspaceId: string, dispatchId: string, verificationId: string) {
      const current = await view(workspaceId, dispatchId)
      const latest = current.runs[0]
      if (!latest || latest.id !== verificationId || (!current.canAccept && !current.accepted))
        throw new ConflictError(
          'Verification is stale, unfinished, or failed. Review the current version and verify again.'
        )
      const dispatch = input.db.transaction(() => {
        if (
          active.has(workspaceId) ||
          starting.has(workspaceId) ||
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
      const running = active.get(workspaceId)
      if (!running || running.id !== verificationId || running.dispatchId !== dispatchId)
        throw new ConflictError('This verification is no longer running.')
      await cancelWorkspace(workspaceId)
      return view(workspaceId, dispatchId)
    },
    async deleteWorkspace(workspaceId: string) {
      removedWorkspaces.add(workspaceId)
      await Promise.allSettled(pendingStarts)
      await cancelWorkspace(workspaceId)
    },
    assertWorkerIdle(workspaceId: string, workerId: string) {
      if (active.get(workspaceId)?.workerId === workerId || starting.has(workspaceId))
        throw new ConflictError('Cancel the active verification before deleting this worker.')
    },
    async close() {
      closing = true
      // Preflight errors are returned to their initiating requests; none created a job.
      await Promise.allSettled(pendingStarts)
      await Promise.all([...active.keys()].map(cancelWorkspace))
    },
  }
}

export type VerificationRuntime = ReturnType<typeof createVerificationRuntime>
