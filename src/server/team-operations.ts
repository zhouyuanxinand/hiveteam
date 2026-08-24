import type { AgentRuntime } from './agent-runtime.js'
import { buildOrchestratorReportPayload } from './agent-stdin-dispatcher.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { ConflictError } from './http-errors.js'
import type { MessageLogHandle, MessageLogRecord } from './message-log-store.js'
import type { ReportOutboxStore } from './report-outbox-store.js'
import {
  createReportMessage,
  createSendMessage,
  createStatusMessage,
  createUserInputMessage,
} from './runtime-message-builders.js'
import type { WorkspaceStore } from './workspace-store.js'

export interface TeamOperationsInput {
  agentRuntime: AgentRuntime
  createDispatch: (input: {
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
  reportOutbox?: ReportOutboxStore
  runDataMutation?: (mutation: () => void) => void
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
  createDispatch,
  deleteDispatch,
  deleteMessage,
  findOpenDispatch,
  findOpenDispatchById,
  insertMessage,
  markDispatchCancelled,
  markDispatchReportedByWorker,
  markDispatchSubmitted,
  reportOutbox,
  runDataMutation,
  workspaceStore,
}: TeamOperationsInput) => {
  const runMutation = runDataMutation ?? ((mutation: () => void) => mutation())
  const drainingReportOutboxIds = new Set<number>()

  /**
   * Leave entries pending until the terminal input writer has pasted and
   * submitted them. A stopped Orchestrator is normal here: its next `team
   * list` call will retry the same durable entry.
   */
  const drainReportOutbox = (
    workspaceId: string,
    targetAgentId = `${workspaceId}:orchestrator`
  ) => {
    if (!reportOutbox || !agentRuntime.getActiveRunByAgentId(workspaceId, targetAgentId)) {
      return { attempted: 0, firstSyncError: null }
    }

    let attempted = 0
    let firstSyncError: string | null = null
    for (const entry of reportOutbox.listPending(workspaceId, targetAgentId)) {
      if (drainingReportOutboxIds.has(entry.id)) continue
      drainingReportOutboxIds.add(entry.id)
      attempted += 1
      try {
        void agentRuntime
          .deliverSystemMessageToAgent(workspaceId, targetAgentId, entry.payload, {
            requireActiveRun: true,
          })
          .then(() => {
            reportOutbox.markDelivered(entry.id)
          })
          .catch((error: unknown) => {
            console.error('[hive] swallowed:teamReport.outboxDrain', error)
          })
          .finally(() => {
            drainingReportOutboxIds.delete(entry.id)
          })
      } catch (error) {
        drainingReportOutboxIds.delete(entry.id)
        firstSyncError ??= reportForwardErrorMessage(error)
        console.error('[hive] swallowed:teamReport.outboxDrain', error)
      }
    }
    return { attempted, firstSyncError }
  }

  const ensureWorkerRun = async (workspaceId: string, workerId: string, hivePort: string) => {
    if (agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) {
      return
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
    } catch (error) {
      workspaceStore.markAgentStopped(workspaceId, workerId)
      throw error
    }
  }

  const dispatchTask = async (
    workspaceId: string,
    workerId: string,
    text: string,
    input: DispatchTaskInput = {}
  ) => {
    const message = createSendMessage(workspaceId, workerId, text, input.fromAgentId)
    const messageHandle = insertMessage(message)
    let dispatch: DispatchRecord | undefined

    try {
      const dispatchInput: {
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
        await ensureWorkerRun(workspaceId, workerId, input.hivePort ?? '')
        const worker = workspaceStore.getWorker(workspaceId, workerId)
        markDispatchSubmitted(dispatch.id)
        agentRuntime.writeSendPrompt(
          workspaceId,
          workerId,
          dispatch.id,
          sender.name,
          worker.description,
          text
        )
      }

      workspaceStore.markTaskDispatched(workspaceId, workerId)
      return dispatch
    } catch (error) {
      if (dispatch) deleteDispatch(dispatch.id)
      deleteMessage(messageHandle)
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
      workspaceStore.getAgent(workspaceId, orchestratorId)
      agentRuntime.writeUserInputPrompt(workspaceId, text)
      insertMessage(createUserInputMessage(workspaceId, orchestratorId, text))
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
