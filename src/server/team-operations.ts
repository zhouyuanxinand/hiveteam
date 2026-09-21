import { isClarificationSkill } from '../shared/clarification.js'
import { isReportOutcome, type ReportOutcome } from '../shared/dispatch-result.js'
import type { DispatchProgress, DispatchTimeouts } from '../shared/message-delivery.js'
import type { ResolvedSkillActivation } from '../shared/skill-packs.js'
import type { AgentRuntime } from './agent-runtime.js'
import { buildOrchestratorReportPayload } from './agent-stdin-dispatcher.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import type { DispatchSkillActivationStore } from './dispatch-skill-activation-store.js'
import { BadRequestError, ConflictError, HttpError, PtyInactiveError } from './http-errors.js'
import type { MessageLogHandle, MessageLogRecord } from './message-log-store.js'
import { isInteractiveAgentCommand } from './post-start-input-writer.js'
import { RemotePermissionError } from './remote-permission-store.js'
import type { ReportOutboxStore } from './report-outbox-store.js'
import { ResourceLimitError } from './resource-budget-store.js'
import type { ResourceStartQueue } from './resource-start-queue.js'
import {
  createFeedbackMessage,
  createReportMessage,
  createSendMessage,
  createStatusMessage,
  createUserInputMessage,
} from './runtime-message-builders.js'
import type { TeamDeliveryRuntime } from './team-delivery-runtime.js'
import type { WorkspaceStore } from './workspace-store.js'

export interface TeamOperationsInput {
  delivery: TeamDeliveryRuntime
  resourceQueue?: ResourceStartQueue
  captureDispatchAuthorization?: (dispatchId: string) => void
  withDispatchAuthorization?: <T>(dispatchId: string, action: () => T) => T
  assertWorkspaceWritable?: (workspaceId: string) => void
  agentRuntime: AgentRuntime
  /**
   * Optional hook that records the workspace Git HEAD as the dispatch
   * baseline. Must be side-effect free and resolve to null when no baseline
   * is available (non-Git workspace, Git missing); it must never throw.
   */
  captureBaseHeadSha?: (workspaceId: string, workerId: string) => Promise<string | null>
  createDispatch: (input: {
    baseHeadSha?: string | null
    fromAgentId?: string
    text: string
    toAgentId: string
    workspaceId: string
  }) => DispatchRecord
  createDispatchActivation: DispatchSkillActivationStore['insert']
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
  isWorkflowDispatch?: (dispatchId: string) => boolean
  getDispatchActivation: DispatchSkillActivationStore['get']
  clarificationForWorker: DispatchSkillActivationStore['clarificationForWorker']
  listOpenWorkspaceDispatches?: (workspaceId: string) => DispatchRecord[]
  insertMessage: (record: MessageLogRecord) => MessageLogHandle
  markDispatchCancelled: (input: {
    dispatchId: string
    reason: string
    workspaceId: string
  }) => DispatchRecord | undefined
  markDispatchReportedByWorker: (input: {
    outcome?: ReportOutcome
    artifacts: string[]
    dispatchId?: string
    reportText: string
    toAgentId: string
    workspaceId: string
  }) => DispatchRecord | undefined
  markDispatchSubmitted: (dispatchId: string) => void
  onDispatchSubmitted?: (dispatch: DispatchRecord) => void
  /** Optional for lightweight callers that do not persist delivery failures. */
  markDispatchDeliveryFailed?: (dispatchId: string, error: string) => void
  reportOutbox?: ReportOutboxStore
  resolveDispatchActivation: (
    workspaceId: string,
    agentId: string,
    skillName: string
  ) => Promise<ResolvedSkillActivation>
  /** Required for the review-feedback path; optional for lightweight callers. */
  reopenReportedDispatch?: (workspaceId: string, dispatchId: string) => boolean
  runDataMutation?: (mutation: () => void) => void
  /** Optional persistence hook for the review baseline captured post-insert. */
  setDispatchBaseHeadSha?: (dispatchId: string, baseHeadSha: string) => void
  workspaceStore: WorkspaceStore
}

export interface DispatchTaskInput {
  /** Internal transaction hook: attach durable workflow ownership before any delivery. */
  onCreated?: (dispatch: DispatchRecord) => void
  timeouts?: DispatchTimeouts
  fromAgentId?: string
  hivePort?: string
  skillName?: string
}

export interface ReportTaskInput {
  outcome?: ReportOutcome
  artifacts?: string[]
  dispatchId?: string
  requireActiveRun?: boolean
  status?: string
  text?: string
}

export interface StatusTaskInput {
  dispatchId?: string
  progressState?: DispatchProgress | 'accepted' | 'cancelled'
  artifacts?: string[]
  requireActiveRun?: boolean
  text?: string
}

export interface CancelTaskInput {
  fromAgentId: string
  reason: string
}

export interface ReportTaskResult {
  duplicate?: boolean
  lateReportId?: string
  deliveryState?: ReportDeliveryState
  dispatch: DispatchRecord | null
  forwardError: string | null
  forwarded: boolean
}

export type ReportDeliveryState = 'delivering' | 'queued' | 'failed'

const reportForwardErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export const createTeamOperations = ({
  delivery,
  resourceQueue,
  captureDispatchAuthorization,
  assertWorkspaceWritable,
  agentRuntime,
  captureBaseHeadSha,
  createDispatch,
  createDispatchActivation,
  deleteDispatch,
  deleteMessage,
  findOpenDispatch,
  findOpenDispatchById,
  getDispatchById,
  isWorkflowDispatch,
  getDispatchActivation,
  clarificationForWorker,
  listOpenWorkspaceDispatches = () => [],
  insertMessage,
  markDispatchCancelled,
  markDispatchReportedByWorker,
  markDispatchDeliveryFailed,
  reportOutbox,
  resolveDispatchActivation,
  reopenReportedDispatch,
  runDataMutation,
  setDispatchBaseHeadSha,
  workspaceStore,
}: TeamOperationsInput) => {
  const runMutation = runDataMutation ?? ((mutation: () => void) => mutation())
  const pendingDispatches = new Set<Promise<DispatchRecord>>()
  const deliveringDispatches = new Map<string, Promise<void>>()
  let closing = false
  let startWorker = (workspaceId: string, workerId: string, hivePort: string) =>
    agentRuntime.startAgent(workspaceStore.getWorkspaceSnapshot(workspaceId).summary, workerId, {
      hivePort,
    })

  const trackDispatch = (pending: Promise<DispatchRecord>) => {
    pendingDispatches.add(pending)
    void pending.then(
      () => pendingDispatches.delete(pending),
      () => pendingDispatches.delete(pending)
    )
    return pending
  }

  const close = async () => {
    closing = true
    await delivery.close()
    while (pendingDispatches.size > 0 || deliveringDispatches.size > 0) {
      await Promise.allSettled([...pendingDispatches, ...deliveringDispatches.values()])
    }
  }

  const drainReportOutbox = delivery.drainReports

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
      const run = await startWorker(workspaceId, workerId, hivePort)
      if (run.status === 'error') {
        workspaceStore.markAgentStopped(workspaceId, workerId)
        throw new ConflictError(`${config.command} failed to start`)
      }
      return true
    } catch (error) {
      workspaceStore.markAgentStopped(workspaceId, workerId)
      if (error instanceof ResourceLimitError && resourceQueue) {
        resourceQueue.enqueue({
          workspaceId,
          agentId: workerId,
          executionKey: `agent:${workerId}`,
          kind: 'worker',
          source: 'dispatch',
          payload: {},
          reason: error.reason,
        })
        return false
      }
      throw error
    }
  }

  const deliverDispatch = (dispatch: DispatchRecord) => {
    const existing = deliveringDispatches.get(dispatch.id)
    if (existing) return existing
    const pending = delivery
      .deliver(dispatch.id)
      .then(() => undefined)
      .finally(() => deliveringDispatches.delete(dispatch.id))
    deliveringDispatches.set(dispatch.id, pending)
    return pending
  }

  const replayQueuedDispatches = async (workspaceId: string, workerId: string) => {
    // Runtime shutdown may race the post-start microtask that normally replays
    // queued work. Do not touch the stores after the shutdown boundary.
    if (closing) return 0
    if (workspaceStore.getAgent(workspaceId, workerId).role === 'orchestrator') return 0
    if (workspaceStore.isAgentManuallyStopped?.(workspaceId, workerId)) return 0
    if (!agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) return 0

    let replayed = 0
    for (const dispatch of listOpenWorkspaceDispatches(workspaceId)) {
      if (
        (dispatch.status !== 'queued' && dispatch.status !== 'failed') ||
        dispatch.toAgentId !== workerId
      ) {
        continue
      }

      try {
        await deliverDispatch(dispatch)
        replayed += 1
      } catch (error) {
        markDispatchDeliveryFailed?.(dispatch.id, reportForwardErrorMessage(error))
        console.error('[hive] queued dispatch replay failed', {
          dispatchId: dispatch.id,
          error: reportForwardErrorMessage(error),
          workerId,
          workspaceId,
        })
        if (error instanceof RemotePermissionError) continue
        break
      }
    }
    return replayed
  }

  const dispatchTaskImpl = async (
    workspaceId: string,
    workerId: string,
    text: string,
    input: DispatchTaskInput = {}
  ) => {
    assertWorkspaceWritable?.(workspaceId)
    if (text.trim().length === 0) {
      throw new BadRequestError('Task text cannot be empty')
    }
    let skillActivation: ResolvedSkillActivation | undefined
    if (input.skillName) {
      if (!runDataMutation) {
        throw new ConflictError('Skill dispatch requires transactional persistence')
      }
      skillActivation = await resolveDispatchActivation(workspaceId, workerId, input.skillName)
    }
    // Start baseline capture after any requested Skill has been validated but
    // before the dispatch can cause worker edits. For ordinary dispatches this
    // preserves the historical pre-await synchronous persistence path.
    const baseHeadCapture = captureBaseHeadSha ? captureBaseHeadSha(workspaceId, workerId) : null
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
      if (input.onCreated && baseHeadCapture) dispatchInput.baseHeadSha = await baseHeadCapture
      if (input.fromAgentId) dispatchInput.fromAgentId = input.fromAgentId
      let createdDispatch: DispatchRecord | undefined
      runMutation(() => {
        const interview = clarificationForWorker(workspaceId, workerId)
        if (interview?.active)
          throw new ConflictError(
            'This member is conducting a clarification. Finish or cancel it before dispatching another task.'
          )
        if (skillActivation && isClarificationSkill(skillActivation.skillName)) {
          const worker = workspaceStore.getWorker(workspaceId, workerId)
          if (worker.status !== 'idle' || findOpenDispatch(workspaceId, workerId))
            throw new ConflictError(
              'Clarification requires an idle member with no pending dispatches.'
            )
        }
        const candidate = createDispatch(dispatchInput)
        input.onCreated?.(candidate)
        captureDispatchAuthorization?.(candidate.id)
        if (input.timeouts)
          delivery.health.configure(
            workspaceId,
            input.timeouts,
            input.fromAgentId ?? 'local_user',
            candidate.id
          )
        if (skillActivation) createDispatchActivation(candidate.id, skillActivation)
        createdDispatch = candidate
      })
      if (!createdDispatch) throw new Error('Dispatch persistence failed')
      dispatch = createdDispatch
      if (!input.fromAgentId) workspaceStore.markTaskDispatched(workspaceId, workerId)

      if (input.fromAgentId) {
        workspaceStore.getAgent(workspaceId, input.fromAgentId)
        const workerStarted = await ensureWorkerRun(workspaceId, workerId, input.hivePort ?? '')
        workspaceStore.getWorker(workspaceId, workerId)
        if (findOpenDispatch(workspaceId, workerId, dispatch.id))
          workspaceStore.markTaskDispatched(workspaceId, workerId)
        if (workerStarted) {
          // A start-triggered replay can run in the microtask immediately after
          // ensureWorkerRun resolves. If it already accepted this dispatch,
          // don't inject the same task a second time.
          const replayedDispatch = findOpenDispatch(workspaceId, workerId, dispatch.id)
          if (replayedDispatch?.status !== 'submitted') {
            const delivering = dispatch
            const delivery = deliverDispatch(delivering)
            const config = agentRuntime.peekAgentLaunchConfig(workspaceId, workerId)
            if (!isInteractiveAgentCommand(config?.interactiveCommand ?? config?.command ?? ''))
              await delivery
            else
              void delivery.catch((error: unknown) => {
                if (findOpenDispatch(workspaceId, workerId, delivering.id))
                  markDispatchDeliveryFailed?.(delivering.id, reportForwardErrorMessage(error))
              })
          }
        }
      }

      if (baseHeadCapture) {
        // The baseline is enrichment on top of an already-committed dispatch.
        // A store closing mid-capture must not surface as a delivery failure.
        try {
          const baseHeadSha = await baseHeadCapture
          if (baseHeadSha) {
            setDispatchBaseHeadSha?.(dispatch.id, baseHeadSha)
            dispatch = { ...dispatch, baseHeadSha }
          }
        } catch (error) {
          console.error('[hive] swallowed:dispatchTask.baseHeadCapture', error)
        }
      }
      // A worker-start replay may have accepted the dispatch while
      // ensureWorkerRun was yielding. Return the durable record so callers
      // immediately see the submitted/failed state instead of the stale
      // queued object created above.
      return findOpenDispatch(workspaceId, workerId, dispatch.id) ?? dispatch
    } catch (error) {
      if (baseHeadCapture) {
        try {
          await baseHeadCapture
        } catch (captureError) {
          console.error('[hive] swallowed:dispatchTask.failedBaseHeadCapture', captureError)
        }
      }
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

  const dispatchTask = (...args: Parameters<typeof dispatchTaskImpl>) => {
    if (closing) {
      return Promise.reject(new ConflictError('Hive runtime is closing'))
    }
    return trackDispatch(dispatchTaskImpl(...args))
  }

  return {
    setAgentStarter(start: typeof startWorker) {
      startWorker = start
    },
    close,
    cancelTask(workspaceId: string, dispatchId: string, input: CancelTaskInput) {
      workspaceStore.getAgent(workspaceId, input.fromAgentId)
      const openDispatch = findOpenDispatchById(workspaceId, dispatchId)
      if (!openDispatch) {
        throw new ConflictError(`No open dispatch: ${dispatchId}`)
      }
      let dispatch: DispatchRecord | undefined
      runMutation(() => {
        dispatch = markDispatchCancelled({ dispatchId, reason: input.reason, workspaceId })
        if (dispatch)
          delivery.prepareCancellation(workspaceId, dispatch.id, dispatch.toAgentId, input.reason)
      })
      if (!dispatch) {
        throw new ConflictError(`No open dispatch: ${dispatchId}`)
      }
      workspaceStore.markTaskCancelled(workspaceId, dispatch.toAgentId)
      if (!findOpenDispatch(workspaceId, dispatch.toAgentId)) {
        for (const entry of resourceQueue?.list(workspaceId) ?? [])
          if (entry.agent_id === dispatch.toAgentId && entry.source === 'dispatch')
            resourceQueue?.cancel(entry.id, { pauseAgent: false })
      }
      delivery.interrupt(dispatch.id)
      return { dispatch, forwardError: null, forwarded: false }
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
      const interview = clarificationForWorker(workspaceId, dispatch.toAgentId)
      const isInterview = isClarificationSkill(getDispatchActivation(dispatchId)?.skillName ?? '')
      if (interview?.active && interview.dispatchId !== dispatchId)
        throw new ConflictError(
          'This member is conducting a clarification. Finish or cancel it before reopening other work.'
        )
      if (isInterview && interview?.dispatchId !== dispatchId)
        throw new ConflictError(
          'This member has moved to another task. Start a new clarification dispatch instead of reopening the old interview.'
        )
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

      insertMessage({
        ...createFeedbackMessage(workspaceId, dispatch.toAgentId, text),
        ...(isInterview ? { type: 'member_feedback' as const } : {}),
      })
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
      const isolated = !!clarificationForWorker(workspaceId, workerId)
      if (input.progressState) {
        if (!input.dispatchId)
          throw new BadRequestError('dispatch_id is required for structured progress')
        const current = getDispatchById?.(workspaceId, input.dispatchId)
        if (!current || current.toAgentId !== workerId)
          throw new HttpError(404, 'Dispatch not found for this worker')
        if (input.progressState === 'cancelled') {
          delivery.health.confirmCancellation(
            workspaceId,
            current.id,
            workerId,
            'worker_ack',
            workerId
          )
          for (const entry of delivery.records.list(workspaceId, workerId)) {
            if (entry.dispatch_id === current.id && entry.kind === 'cancel')
              delivery.records.confirm(entry.id, 'worker_ack')
          }
        } else if (input.progressState === 'accepted') {
          if (current.status === 'cancelled' || current.status === 'reported')
            throw new ConflictError('Dispatch is closed')
          delivery.acknowledge(workspaceId, current.id, workerId)
        } else delivery.health.progress(workspaceId, current.id, workerId, input.progressState)
        delivery.wake()
      }
      const messageHandle = insertMessage({
        ...createStatusMessage(workspaceId, workerId, text, artifacts),
        ...(isolated ? { toAgentId: workerId } : {}),
      })
      try {
        let forwardError: string | null = null
        let forwarded = false
        if (input.requireActiveRun === true && !isolated) {
          try {
            if (
              delivery.records
                .list(workspaceId, `${workspaceId}:orchestrator`)
                .some((entry) => entry.state !== 'confirmed' && entry.state !== 'resolved')
            )
              throw new ConflictError(
                'Status recorded. Finish the pending delivery or review the Orchestrator composer before further automatic input.'
              )
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
      if (input.outcome !== undefined && !isReportOutcome(input.outcome)) {
        throw new BadRequestError('outcome must be success, failed, blocked, or partial')
      }
      const text = input.text ?? ''
      const status = input.status
      const artifacts = input.artifacts ?? []
      const worker = workspaceStore.getWorker(workspaceId, workerId)
      const openDispatch = findOpenDispatch(workspaceId, workerId, input.dispatchId)
      if (!input.dispatchId && openDispatch && isWorkflowDispatch?.(openDispatch.id))
        throw new BadRequestError(
          'dispatch_id is required for a workflow attempt. Use the id supplied with the current task.'
        )
      if (!openDispatch && input.dispatchId) {
        const existing = getDispatchById?.(workspaceId, input.dispatchId)
        if (existing?.status === 'cancelled' && existing.toAgentId === workerId) {
          const lateReportId = delivery.health.lateReport(workspaceId, existing.id, workerId, {
            text,
            artifacts,
            outcome: input.outcome ?? null,
          })
          return { dispatch: null, forwarded: false, forwardError: null, lateReportId }
        }
        if (
          existing?.status === 'reported' &&
          existing.toAgentId === workerId &&
          existing.reportText === text &&
          JSON.stringify(existing.artifacts) === JSON.stringify(artifacts) &&
          existing.reportOutcome === (input.outcome ?? null)
        ) {
          delivery.wake()
          return {
            duplicate: true,
            dispatch: existing,
            forwarded: false,
            forwardError: null,
            deliveryState: 'queued' as const,
          }
        }
        throw new ConflictError(`No open dispatch for worker: ${worker.name}`)
      }
      if (!openDispatch) {
        throw new ConflictError(`No open dispatch for worker: ${worker.name}`)
      }
      const orchestratorId = `${workspaceId}:orchestrator`
      const shouldQueueForOrchestrator =
        input.requireActiveRun === true && reportOutbox !== undefined
      const payload = buildOrchestratorReportPayload(
        worker.name,
        text,
        artifacts,
        undefined,
        input.outcome
      )
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
            ...(input.outcome ? { outcome: input.outcome } : {}),
            ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
            reportText: text,
            toAgentId: workerId,
            workspaceId,
          })
          if (!nextDispatch) {
            throw new ConflictError(`No open dispatch for worker: ${worker.name}`)
          }
          dispatch = nextDispatch
          delivery.records.confirm(nextDispatch.id, 'worker_ack')
          delivery.health.complete(nextDispatch.id)
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

      delivery.interrupt(dispatch.id)
      delivery.wake()
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
              ...(input.outcome ? { outcome: input.outcome } : {}),
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
