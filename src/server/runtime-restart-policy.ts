import type { AgentRunStorePort } from './agent-runtime-ports.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import type { MessageLogHandle, MessageLogRecord, RecoveryMessage } from './message-log-store.js'
import { createRestartPolicy } from './restart-policy.js'
import type { TasksFileService } from './tasks-file.js'
import type { WorkspaceStore } from './workspace-store.js'

// Narrow helper keeps runtime-store under the hard line cap.
export const buildRuntimeRestartPolicy = ({
  agentRunStore,
  dispatchLedgerStore,
  messageLogStore,
  tasksFileService,
  workspaceStore,
}: {
  agentRunStore: Pick<AgentRunStorePort, 'listAgentRuns'>
  dispatchLedgerStore: {
    listWorkspaceDispatches: (workspaceId: string) => DispatchRecord[]
  }
  messageLogStore: {
    deleteMessage: (handle: MessageLogHandle) => void
    insertMessage: (record: MessageLogRecord) => MessageLogHandle
    listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  }
  tasksFileService: Pick<TasksFileService, 'readTasks'>
  workspaceStore: Pick<WorkspaceStore, 'getWorkspaceSnapshot'>
}) =>
  createRestartPolicy({
    deleteMessage: messageLogStore.deleteMessage,
    getWorkspaceSnapshot: workspaceStore.getWorkspaceSnapshot,
    insertMessage: messageLogStore.insertMessage,
    listAgentRuns: agentRunStore.listAgentRuns,
    listOpenDispatches: dispatchLedgerStore.listWorkspaceDispatches,
    listMessagesForRecovery: messageLogStore.listMessagesForRecovery,
    readTasks: tasksFileService.readTasks,
  })
