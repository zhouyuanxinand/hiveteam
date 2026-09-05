import type { AgentRuntime } from './agent-runtime.js'
import { buildOrchestratorReportPayload } from './agent-stdin-dispatcher.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { BadRequestError, ConflictError, HttpError, PtyInactiveError } from './http-errors.js'
import type { MessageLogHandle, MessageLogRecord } from './message-log-store.js'
import type { ReportOutboxStore } from './report-outbox-store.js'
import {
  createFeedbackMessage,
  createReportMessage,
  createSendMessage,
  createStatusMessage,
  createUserInputMessage,
} from './runtime-message-builders.js'
import type { WorkspaceStore } from './workspace-store.js'

export interface TeamOperationsInput {
  agentRuntime: AgentRuntime
  /**
   * Optional hook that records the workspace Git HEAD as the dispatch
   * baseline. Must be side-effect free and resolve to null when no baseline
   * is available (non-Git workspace, Git missing); it must never throw.
   */
  captureBaseHeadSha?: (workspaceId: string) => Promise<string | null>
  createDispatch: (input: {
    baseHeadSha?: string | null
    fromAgentId?: string
    text: string
    toAgentId: string
    workspaceId: string
  }) => DispatchRecord
  deleteDispatch: (dispatchId: string) => void
  deleteMessage: (handle: MessageLogHandle) => void
  findOpenDispatch: (
    workspaceId: string,
    toAgentId: string,
    dispatchId?: string
  ) => DispatchRecord | undefined
  findOpenDispatchById: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  /** Required for the review-feedback path; optional for lightweight callers. */
  getDispatchById?: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  listOpenWorkspaceDispatches?: (workspaceId: string) => DispatchRecord[]
  insertMessage: (record: MessageLogRecord) => MessageLogHandle
  markDispatchCancelled: (input: {
    dispatchId: string
    reason: string
    workspaceId: string
  }) => DispatchRecord | undefined
  markDispatchReportedByWorker: (input: {
    artifacts: string[]
    dispatchId?: string
    reportText: string
    toAgentId: string
    workspaceId: string
  }) => DispatchRecord | undefined
  markDispatchSubmitted: (dispatchId: string) => void
  /** Optional for lightweight callers that do not persist delivery failures. */
  markDispatchDeliveryFailed?: (dispatchId: string, error: string) => void
  reportOutbox?: ReportOutboxStore
  /** Required for the review-feedback path; optional for lightweight callers. */
  reopenReportedDispatch?: (workspaceId: string, dispatchId: string) => boolean
  runDataMutation?: (mutation: () => void) => void
  /** Optional persistence hook for the review baseline captured post-insert. */
  setDispatchBaseHeadSha?: (dispatchId: string, baseHeadSha: string) => void
  workspaceStore: WorkspaceStore
}

export interface DispatchTaskInput {
  fromAgentId?: string
  hivePort?: string
}

export interface ReportTaskInput {
  artifacts?: string[]
  dispatchId?: string
  requireActiveRun?: boolean
  status?: string
  text?: string
}

export interface StatusTaskInput {
  artifacts?: string[]
  requireActiveRun?: boolean
  text?: string
}

export interface CancelTaskInput {
  fromAgentId: string
  reason: string
}

export interface ReportTaskResult {
  deliveryState?: ReportDeliveryState
  dispatch: DispatchRecord | null
  forwardError: string | null
  forwarded: boolean
}

export type ReportDeliveryState = 'delivering' | 'queued' | 'failed'

const reportForwardErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export const createTeamOperations = ({
  agentRuntime,
  captureBaseHeadSha,
  createDispatch,
  deleteDispatch,
  deleteMessage,
  findOpenDispatch,
  findOpenDispatchById,
  getDispatchById,
  listOpenWorkspaceDispatches = () => [],
  insertMessage,
  markDispatchCancelled,
  markDispatchReportedByWorker,
  markDispatchSubmitted,
  markDispatchDeliveryFailed,
  reportOutbox,
  reopenReportedDispatch,
  runDataMutation,
  setDispatchBaseHeadSha,
  workspaceStore,
}: TeamOperationsInput) => {
  const runMutation = runDataMutation ?? ((mutation: () => void) => mutation())
  const drainingReportOutboxIds = new Set<number>()

  /**
   * Leave entries pending until the terminal input writer has pasted and
   * submitted them. A stopped Orchestrator is normal here: its next `team
   * list` call will retry the same durable entry.
   *
   * Failed entries retry with exponential backoff so a persistently
   * undeliverable report (e.g. an Orchestrator TUI that keeps rejecting
   * pastes) does not get retried on every drain trigger. The first retry
   * stays immediate so a transient paste race recovers at the next drain
   * event; backoff applies from the second failure on. Entries never
   * expire — backoff spaces retries out, it does not give up.
   */
  const reportDeliveryBackoffMs = (attemptCount: number) =>
    attemptCount <= 1 ? 0 : Math.min(30_000 * 2 ** (attemptCount - 1), 30 * 60_000)

  const drainReportOutbox = (
    workspaceId: string,
    targetAgentId = `${workspaceId}:orchestrator`
  ) => {
    if (!reportOutbox || !agentRuntime.getActiveRunByAgentId(workspaceId, targetAgentId)) {
      return { attempted: 0, firstSyncError: null }
    }

    const now = Date.now()
    let attempted = 0
    let firstSyncError: string | null = null
    for (const entry of reportOutbox.listPending(workspaceId, targetAgentId)) {
      if (drainingReportOutboxIds.has(entry.id)) continue
      if (
        entry.lastDeliveryAttemptAt !== null &&
        now - entry.lastDeliveryAttemptAt < reportDeliveryBackoffMs(entry.deliveryAttemptCount)
      ) {
        continue
      }
      drainingReportOutboxIds.add(entry.id)
      attempted += 1
      try {
        reportOutbox.markDeliveryAttempt(entry.id)
        void agentRuntime
          .deliverSystemMessageToAgent(workspaceId, targetAgentId, entry.payload, {
            requireActiveRun: true,
          })
          .then(() => {
            reportOutbox.markDelivered(entry.id)
          })
          .catch((error: unknown) => {
            reportOutbox.markDeliveryFailed(entry.id, reportForwardErrorMessage(error))
            console.error('[hive] swallowed:teamReport.outboxDrain', error)
          })
          .finally(() => {
            drainingReportOutboxIds.delete(entry.id)
          })
      } catch (error) {
        reportOutbox.markDeliveryFailed(entry.id, reportForwardErrorMessage(error))
        drainingReportOutboxIds.delete(entry.id)
        firstSyncError ??= reportForwardErrorMessage(error)
        console.error('[hive] swallowed:teamReport.outboxDrain', error)
      }
    }
    return { attempted, firstSyncError }
  }

  const ensureWorkerRun = async (workspaceId: string, workerId: string, hivePort: string) => {
    if (agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) {
      return true
    }

    // A manual stop is an explicit user choice. Keep the dispatch durable and
    // queued until the user starts this worker again; dispatching must not
    // silently undo that choice by starting a new PTY.
    if (workspaceStore.isAgentManuallyStopped?.(workspaceId, workerId)) {
      return false
    }

    const config = agentRuntime.peekAgentLaunchConfig(workspaceId, workerId)
    if (!config) {
      throw new ConflictError('No worker launch config available')
    }

    workspaceStore.markAgentStarted(workspaceId, workerId)
    try {
      const run = await agentRuntime.startAgent(
        workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
        workerId,
        { hivePort }
      )
      if (run.status === 'error') {
        workspaceStore.markAgentStopped(workspaceId, workerId)
        throw new ConflictError(`${config.command} failed to start`)
      }
      return true
    } catch (error) {
      workspaceStore.markAgentStopped(workspaceId, workerId)
      throw error
    }
  }

  const replayQueuedDispatches = (workspaceId: string, workerId: string) => {
    if (workspaceStore.getAgent(workspaceId, workerId).role === 'orchestrator') return 0
    if (workspaceStore.isAgentManuallyStopped?.(workspaceId, workerId)) return 0
    if (!agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) return 0

    const worker = workspaceStore.getWorker(workspaceId, workerId)
    const language = workspaceStore.getWorkspaceSnapshot(workspaceId).summary.language ?? 'zh'
    let replayed = 0
    for (const dispatch of listOpenWorkspaceDispatches(workspaceId)) {
      if (
        (dispatch.status !== 'queued' && dispatch.status !== 'failed') ||
        dispatch.toAgentId !== workerId
      ) {
        continue
      }

      try {
        const sender = dispatch.fromAgentId
          ? workspaceStore.getAgent(workspaceId, dispatch.fromAgentId)
          : null
        agentRuntime.writeSendPrompt(
          workspaceId,
          workerId,
          dispatch.id,
          sender?.name ?? 'Hive',
          worker.description,
          dispatch.text,
          language
        )
        markDispatchSubmitted(dispatch.id)
        replayed += 1
      } catch (error) {
        markDispatchDeliveryFailed?.(dispatch.id, reportForwardErrorMessage(error))
        console.error('[hive] queued dispatch replay failed', {
          dispatchId: dispatch.id,
          error: reportForwardErrorMessage(error),
          workerId,
          workspaceId,
        })
        break
      }
    }
    return replayed
  }

  const dispatchTask = async (
    workspaceId: string,
    workerId: string,
    text: string,
    input: DispatchTaskInput = {}
  ) => {
    if (text.trim().length === 0) {
      throw new BadRequestError('Task text cannot be empty')
    }
    // Kick off the review-baseline capture immediately so the HEAD it reads
    // predates any worker edit, but only await it after all synchronous state
    // mutations — dispatchTask historically commits the dispatch row and the
    // worker's working status before its first await, and callers rely on
    // that. The hook is documented as never throwing.
    const baseHeadCapture = captureBaseHeadSha ? captureBaseHeadSha(workspaceId) : null
    const message = createSendMessage(workspaceId, workerId, text, input.fromAgentId)
    const messageHandle = insertMessage(message)
    let dispatch: DispatchRecord | undefined

    try {
      const dispatchInput: {
        baseHeadSha?: string | null
        fromAgentId?: string
        text: string
        toAgentId: string
        workspaceId: string
      } = {
        text,
        toAgentId: workerId,
        workspaceId,
      }
      if (input.fromAgentId) dispatchInput.fromAgentId = input.fromAgentId
      dispatch = createDispatch(dispatchInput)

      if (input.fromAgentId) {
        const sender = workspaceStore.getAgent(workspaceId, input.fromAgentId)
        const workerStarted = await ensureWorkerRun(workspaceId, workerId, input.hivePort ?? '')
        const worker = workspaceStore.getWorker(workspaceId, workerId)
        const language = workspaceStore.getWorkspaceSnapshot(workspaceId).summary.language ?? 'zh'
        if (workerStarted) {
          // A start-triggered replay can run in the microtask immediately after
          // ensureWorkerRun resolves. If it already accepted this dispatch,
          // don't inject the same task a second time.
          const replayedDispatch = findOpenDispatch(workspaceId, workerId, dispatch.id)
          if (replayedDispatch?.status !== 'submitted') {
            markDispatchSubmitted(dispatch.id)
            agentRuntime.writeSendPrompt(
              workspaceId,
              workerId,
              dispatch.id,
              sender.name,
              worker.description,
              text,
              language
            )
          }
        }
      }

      workspaceStore.markTaskDispatched(workspaceId, workerId)
      if (baseHeadCapture) {
        const baseHeadSha = await baseHeadCapture
        if (baseHeadSha) {
          setDispatchBaseHeadSha?.(dispatch.id, baseHeadSha)
          dispatch = { ...dispatch, baseHeadSha }
        }
      }
      // A worker-start replay may have accepted the dispatch while
      // ensureWorkerRun was yielding. Return the durable record so callers
      // immediately see the submitted/failed state instead of the stale
      // queued object created above.
      return findOpenDispatch(workspaceId, workerId, dispatch.id) ?? dispatch
    } catch (error) {
      if (dispatch && markDispatchDeliveryFailed) {
        markDispatchDeliveryFailed(
          dispatch.id,
          error instanceof Error ? error.message : String(error)
        )
        // Keep the durable message and dispatch. The next worker start can
        // replay the same task instead of silently losing it.
      } else {
        // Preserve rollback semantics for isolated callers that do not provide
        // the durable failure ledger.
        if (dispatch) deleteDispatch(dispatch.id)
        deleteMessage(messageHandle)
      }
      throw error
    }
  }

  return {
    cancelTask(workspaceId: string, dispatchId: string, input: CancelTaskInput) {
      workspaceStore.getAgent(workspaceId, input.fromAgentId)
      const openDispatch = findOpenDispatchById(workspaceId, dispatchId)
      if (!openDispatch) {
        throw new ConflictError(`No open dispatch: ${dispatchId}`)
      }
      const dispatch = markDispatchCancelled({
        dispatchId,
        reason: input.reason,
        workspaceId,
      })
      if (!dispatch) {
        throw new ConflictError(`No open dispatch: ${dispatchId}`)
      }
      workspaceStore.markTaskCancelled(workspaceId, dispatch.toAgentId)
      let forwardError: string | null = null
      let forwarded = false
      try {
        agentRuntime.writeCancelPrompt(workspaceId, dispatch.toAgentId, dispatch.id, input.reason)
        forwarded = true
      } catch (error) {
        forwardError = reportForwardErrorMessage(error)
        console.error('[hive] swallowed:teamCancel.forward', error)
      }
      return { dispatch, forwardError, forwarded }
    },
    dispatchTask,
    drainReportOutbox,
    replayQueuedDispatches,
    dispatchTaskByWorkerName(
      workspaceId: string,
      workerName: string,
      text: string,
      input: DispatchTaskInput = {}
    ) {
      const worker = workspaceStore.getWorkerByName(workspaceId, workerName)
      return dispatchTask(workspaceId, worker.id, text, input)
    },
    recordUserInput(workspaceId: string, orchestratorId: string, text: string) {
      if (text.trim().length === 0) {
        throw new BadRequestError('User input cannot be empty')
      }
      workspaceStore.getAgent(workspaceId, orchestratorId)
      agentRuntime.writeUserInputPrompt(workspaceId, text)
      insertMessage(createUserInputMessage(workspaceId, orchestratorId, text))
    },
    sendDispatchFeedback(workspaceId: string, dispatchId: string, text: string) {
      if (text.trim().length === 0) {
        throw new BadRequestError('Feedback text cannot be empty')
      }
      if (!getDispatchById) {
        throw new Error('Dispatch lookup is not configured for this caller')
      }
      const dispatch = getDispatchById(workspaceId, dispatchId)
      if (!dispatch) {
        throw new HttpError(404, 'Dispatch not found')
      }
      if (dispatch.status === 'cancelled') {
        throw new ConflictError('This dispatch was cancelled; dispatch a new task instead')
      }
      // Feedback only makes sense when the worker can actually read it.
      if (!agentRuntime.getActiveRunByAgentId(workspaceId, dispatch.toAgentId)) {
        throw new PtyInactiveError('The worker is not running. Start it first, then send feedback.')
      }

      // A reported dispatch reopens so the worker can address the feedback
      // and report again under the same dispatch id. DB first, then the
      // in-memory pending counter.
      if (dispatch.status === 'reported' && reopenReportedDispatch) {
        if (reopenReportedDispatch(workspaceId, dispatchId)) {
          workspaceStore.markTaskDispatched(workspaceId, dispatch.toAgentId)
        }
      }

      insertMessage(createFeedbackMessage(workspaceId, dispatch.toAgentId, text))
      try {
        agentRuntime.writeWorkerFeedbackPrompt(workspaceId, dispatch.toAgentId, dispatchId, text)
      } catch (error) {
        markDispatchDeliveryFailed?.(
          dispatch.id,
          error instanceof Error ? error.message : String(error)
        )
        throw error
      }
      return getDispatchById(workspaceId, dispatchId) ?? dispatch
    },
    statusTask(workspaceId: string, workerId: string, input: StatusTaskInput = {}) {
      const text = input.text ?? ''
      const artifacts = input.artifacts ?? []
      const worker = workspaceStore.getWorker(workspaceId, workerId)
      const messageHandle = insertMessage(
        createStatusMessage(workspaceId, workerId, text, artifacts)
      )
      try {
        let forwardError: string | null = null
        let forwarded = false
        if (input.requireActiveRun === true) {
          try {
            agentRuntime.writeStatusPrompt(workspaceId, worker.name, workerId, text, artifacts, {
              requireActiveRun: input.requireActiveRun,
            })
            forwarded = true
          } catch (error) {
            forwardError = reportForwardErrorMessage(error)
            console.error('[hive] swallowed:teamStatus.forward', error)
          }
        }
        return { dispatch: null, forwardError, forwarded }
      } catch (error) {
        deleteMessage(messageHandle)
        throw error
      }
    },
    reportTask(workspaceId: string, workerId: string, input: ReportTaskInput = {}) {
      const text = input.text ?? ''
      const status = input.status
      const artifacts = input.artifacts ?? []
      const worker = workspaceStore.getWorker(workspaceId, workerId)
      const openDispatch = findOpenDispatch(workspaceId, workerId, input.dispatchId)
      if (!openDispatch && input.dispatchId) {
        throw new ConflictError(`No open dispatch for worker: ${worker.name}`)
      }
      if (!openDispatch) {
        throw new ConflictError(`No open dispatch for worker: ${worker.name}`)
      }
      const orchestratorId = `${workspaceId}:orchestrator`
      const shouldQueueForOrchestrator =
        input.requireActiveRun === true && reportOutbox !== undefined
      const payload = buildOrchestratorReportPayload(worker.name, text, artifacts)
      let messageHandle: MessageLogHandle | undefined
      let dispatch: DispatchRecord | undefined
      let reportQueuedBeforeCommit = false

      if (
        shouldQueueForOrchestrator &&
        agentRuntime.getActiveRunByAgentId(workspaceId, orchestratorId)
      ) {
        drainReportOutbox(workspaceId, orchestratorId)
      }

      try {
        runMutation(() => {
          messageHandle = insertMessage(
            createReportMessage(workspaceId, workerId, text, status, artifacts)
          )
          if (shouldQueueForOrchestrator) {
            reportOutbox.enqueue({
              dispatchId: openDispatch.id,
              payload,
              targetAgentId: orchestratorId,
              workspaceId,
            })
            reportQueuedBeforeCommit = true
          }
          const nextDispatch = markDispatchReportedByWorker({
            artifacts,
            ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
            reportText: text,
            toAgentId: workerId,
            workspaceId,
          })
          if (!nextDispatch) {
            throw new ConflictError(`No open dispatch for worker: ${worker.name}`)
          }
          dispatch = nextDispatch
        })
      } catch (error) {
        if (!runDataMutation) {
          if (reportQueuedBeforeCommit) {
            try {
              reportOutbox?.deletePendingForDispatch(openDispatch.id)
            } catch (rollbackError) {
              console.error('[hive] swallowed:teamReport.outboxRollback', rollbackError)
            }
          }
          if (messageHandle) deleteMessage(messageHandle)
        }
        throw error
      }

      if (!dispatch) throw new Error('Report dispatch was not committed')

      workspaceStore.markTaskReported(workspaceId, workerId)
      let deliveryState: ReportDeliveryState | undefined
      let forwardError: string | null = null
      let forwarded = false
      if (input.requireActiveRun === true) {
        if (shouldQueueForOrchestrator) {
          if (agentRuntime.getActiveRunByAgentId(workspaceId, orchestratorId)) {
            const drainResult = drainReportOutbox(workspaceId, orchestratorId)
            if (drainResult.firstSyncError) {
              deliveryState = reportQueuedBeforeCommit ? 'queued' : 'failed'
              forwardError = drainResult.firstSyncError
            } else {
              deliveryState = 'delivering'
            }
          } else {
            deliveryState = reportQueuedBeforeCommit ? 'queued' : 'failed'
            forwardError = reportQueuedBeforeCommit
              ? 'Orchestrator is not running; report queued for delivery.'
              : 'Orchestrator is not running; report could not be queued for delivery.'
          }
        } else {
          try {
            agentRuntime.writeReportPrompt(workspaceId, worker.name, workerId, text, artifacts, {
              requireActiveRun: input.requireActiveRun,
            })
            forwarded = true
          } catch (error) {
            forwardError = reportForwardErrorMessage(error)
            console.error('[hive] swallowed:teamReport.forward', error)
          }
        }
      }
      return {
        ...(deliveryState ? { deliveryState } : {}),
        dispatch,
        forwardError,
        forwarded,
      }
    },
  }
}
