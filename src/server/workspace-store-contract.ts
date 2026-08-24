import type { AgentSummary, TeamListItem, WorkerRole, WorkspaceSummary } from '../shared/types.js'

export interface WorkspaceRecord {
  autoResumeOnRestart: boolean
  summary: WorkspaceSummary
  agents: AgentSummary[]
}

export interface WorkerInput {
  description?: string
  name: string
  role: WorkerRole
}

export interface WorkspaceStore {
  addWorker: (workspaceId: string, input: WorkerInput) => AgentSummary
  createWorkspace: (path: string, name: string) => WorkspaceSummary
  deleteWorkspace: (workspaceId: string) => void
  deleteWorker: (workspaceId: string, workerId: string) => void
  renameWorker: (workspaceId: string, workerId: string, name: string) => AgentSummary
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
  markTaskDispatched: (workspaceId: string, workerId: string) => void
  markTaskCancelled: (workspaceId: string, workerId: string) => void
  markTaskReported: (workspaceId: string, workerId: string) => void
}
