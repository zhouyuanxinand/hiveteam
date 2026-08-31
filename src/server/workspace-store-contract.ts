import type {
  AgentSummary,
  TeamListItem,
  WorkerRole,
  WorkspaceLanguage,
  WorkspaceSummary,
} from '../shared/types.js'

export interface WorkspaceRecord {
  autoResumeOnRestart: boolean
  manualStoppedAgentIds?: Set<string>
  summary: WorkspaceSummary
  agents: AgentSummary[]
}

export interface WorkerInput {
  avatar?: string | null
  description?: string
  name: string
  role: WorkerRole
}

export interface WorkspaceStore {
  addWorker: (workspaceId: string, input: WorkerInput) => AgentSummary
  createWorkspace: (path: string, name: string, language?: WorkspaceLanguage) => WorkspaceSummary
  deleteWorkspace: (workspaceId: string) => void
  deleteWorker: (workspaceId: string, workerId: string) => void
  renameWorker: (workspaceId: string, workerId: string, name: string) => AgentSummary
  setWorkerAvatar: (workspaceId: string, workerId: string, avatar: string | null) => AgentSummary
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getWorker: (workspaceId: string, workerId: string) => AgentSummary
  getWorkerByName: (workspaceId: string, workerName: string) => AgentSummary
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  getWorkspaceRecoverySettings: (workspaceId: string) => { autoResumeOnRestart: boolean }
  hasAgent: (workspaceId: string, agentId: string) => boolean
  listWorkers: (workspaceId: string) => TeamListItem[]
  listWorkspaces: () => WorkspaceSummary[]
  setAutoResumeOnRestart: (workspaceId: string, enabled: boolean) => void
  markAgentStarted: (workspaceId: string, agentId: string) => void
  markAgentStopped: (workspaceId: string, agentId: string) => void
  markAgentManuallyStopped: (workspaceId: string, agentId: string) => void
  isAgentManuallyStopped: (workspaceId: string, agentId: string) => boolean
  markTaskDispatched: (workspaceId: string, workerId: string) => void
  markTaskCancelled: (workspaceId: string, workerId: string) => void
  markTaskReported: (workspaceId: string, workerId: string) => void
}
