import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import type { PersistedAgentRun } from './agent-run-store.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import type { MessageLogHandle, MessageLogRecord, RecoveryMessage } from './message-log-store.js'

export interface RestartPolicyInput {
  deleteMessage: (handle: MessageLogHandle) => void
  getWorkspaceSnapshot: (workspaceId: string) => {
    agents: AgentSummary[]
    summary: WorkspaceSummary
  }
  insertMessage: (record: MessageLogRecord) => MessageLogHandle
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listOpenDispatches: (workspaceId: string) => DispatchRecord[]
  listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  readTasks: (workspacePath: string) => string
}

export const findPreviousRun = (runs: PersistedAgentRun[], currentRunId: string) =>
  runs.find((run) => run.runId !== currentRunId)

export const persistSystemMessage = ({
  deleteMessage,
  insertMessage,
  record,
}: {
  deleteMessage: RestartPolicyInput['deleteMessage']
  insertMessage: RestartPolicyInput['insertMessage']
  record: MessageLogRecord
}) => {
  const handle = insertMessage(record)
  return () => deleteMessage(handle)
}
