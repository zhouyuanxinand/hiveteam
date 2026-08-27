import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { buildRecoverySummary } from './recovery-summary.js'
import {
  findPreviousRun,
  type RestartPolicyInput,
  writeSystemMessage,
} from './restart-policy-support.js'
import { createSystemRecoverySummaryMessage } from './runtime-message-builders.js'

const RECOVERY_WINDOW_MS = 60 * 60 * 1000

export interface RestartPolicy {
  injectPostStartMessage: (input: {
    agentId: string
    runId: string
    startConfig: AgentLaunchConfigInput
    workspace: WorkspaceSummary
    writeToRun: (runId: string, text: string) => void
  }) => boolean
}

export const createNoopRestartPolicy = (): RestartPolicy => ({
  injectPostStartMessage() {
    return false
  },
})

export const createRestartPolicy = ({
  deleteMessage,
  getWorkspaceSnapshot,
  insertMessage,
  listAgentRuns,
  listOpenDispatches,
  listMessagesForRecovery,
  readTasks,
}: RestartPolicyInput): RestartPolicy => ({
  injectPostStartMessage({ agentId, runId, startConfig, workspace, writeToRun }) {
    const previousRun = findPreviousRun(listAgentRuns(agentId), runId)

    const snapshot = getWorkspaceSnapshot(workspace.id)
    const agent = snapshot.agents.find((item) => item.id === agentId)
    if (!agent) return false
    const workers = snapshot.agents.filter(
      (item) => item.role !== 'orchestrator' && item.id !== agentId
    )
    const tasksContent = readTasks(snapshot.summary.path)
    const openDispatches = listOpenDispatches(workspace.id).filter(
      (dispatch) =>
        dispatch.status === 'queued' ||
        dispatch.status === 'submitted' ||
        dispatch.status === 'failed'
    )
    const relevantDispatches =
      agent.role === 'orchestrator'
        ? openDispatches.filter((dispatch) =>
            workers.some((worker) => worker.id === dispatch.toAgentId)
          )
        : openDispatches.filter((dispatch) => dispatch.toAgentId === agent.id)

    if (startConfig.resumedSessionId) return true

    // A worker must not receive a synthetic "continue" prompt merely because
    // it had an old run. Queued dispatches are replayed by the lifecycle after
    // startup; submitted dispatches are the only worker work that needs a
    // recovery summary here. This makes cancelled/reported historical sends
    // inert and keeps an idle member at its native CLI prompt.
    if (agent.role !== 'orchestrator') {
      if (!relevantDispatches.some((dispatch) => dispatch.status === 'submitted')) return false
    } else if (!previousRun) {
      return false
    }

    const text = buildRecoverySummary({
      agent,
      messages: listMessagesForRecovery(workspace.id, Date.now() - RECOVERY_WINDOW_MS),
      openDispatches: relevantDispatches,
      tasksContent,
      workers,
      workspace,
    })
    writeSystemMessage({
      deleteMessage,
      insertMessage,
      record: createSystemRecoverySummaryMessage(workspace.id, agentId, text),
      runId,
      text,
      writeToRun,
    })
    return true
  },
})
