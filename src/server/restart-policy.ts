import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { buildRecoverySummary } from './recovery-summary.js'
import {
  findPreviousRun,
  persistSystemMessage,
  type RestartPolicyInput,
} from './restart-policy-support.js'
import { createSystemRecoverySummaryMessage } from './runtime-message-builders.js'

const RECOVERY_WINDOW_MS = 60 * 60 * 1000

interface RestartMessageInput {
  agentId: string
  runId: string
  startConfig: AgentLaunchConfigInput
  workspace: WorkspaceSummary
}

export type RestartMessagePlan =
  | { kind: 'skip' }
  | { kind: 'recovery'; text: string; persist: () => () => void }

export interface RestartPolicy {
  preparePostStartMessage: (input: RestartMessageInput) => RestartMessagePlan | null
  injectPostStartMessage: (
    input: RestartMessageInput & {
      writeToRun: (runId: string, text: string) => void
    }
  ) => boolean
}

export const createNoopRestartPolicy = (): RestartPolicy => ({
  preparePostStartMessage() {
    return null
  },
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
}: RestartPolicyInput): RestartPolicy => {
  const preparePostStartMessage = ({
    agentId,
    runId,
    startConfig,
    workspace,
  }: RestartMessageInput): RestartMessagePlan | null => {
    const previousRun = findPreviousRun(listAgentRuns(agentId), runId)

    const snapshot = getWorkspaceSnapshot(workspace.id)
    const agent = snapshot.agents.find((item) => item.id === agentId)
    if (!agent) return null
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

    if (startConfig.resumedSessionId) return { kind: 'skip' }

    // A worker must not receive a synthetic "continue" prompt merely because
    // it had an old run. Queued dispatches are replayed by the lifecycle after
    // startup; submitted dispatches are the only worker work that needs a
    // recovery summary here. This makes cancelled/reported historical sends
    // inert and keeps an idle member at its native CLI prompt.
    if (agent.role !== 'orchestrator') {
      if (!relevantDispatches.some((dispatch) => dispatch.status === 'submitted')) return null
    } else if (!previousRun) {
      return null
    }

    const text = buildRecoverySummary({
      agent,
      messages: listMessagesForRecovery(workspace.id, Date.now() - RECOVERY_WINDOW_MS),
      openDispatches: relevantDispatches,
      tasksContent,
      workers,
      workspace,
    })
    return {
      kind: 'recovery',
      text,
      persist: () =>
        persistSystemMessage({
          deleteMessage,
          insertMessage,
          record: createSystemRecoverySummaryMessage(workspace.id, agentId, text),
        }),
    }
  }
  return {
    preparePostStartMessage,
    injectPostStartMessage(input) {
      const plan = preparePostStartMessage(input)
      if (!plan) return false
      if (plan.kind === 'skip') return true
      const rollback = plan.persist()
      try {
        input.writeToRun(input.runId, plan.text)
      } catch (error) {
        rollback()
        throw error
      }
      return true
    },
  }
}
