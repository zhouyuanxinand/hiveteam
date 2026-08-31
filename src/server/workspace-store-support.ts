import type { AgentStatus, AgentSummary, WorkerRole, WorkspaceLanguage } from '../shared/types.js'
import { getDefaultRoleDescription } from './role-templates.js'

export interface MessageKindRecord {
  type: 'send' | 'report'
  worker_id: string
  workspace_id: string
}

export interface WorkspaceRow {
  auto_resume: number | null
  id: string
  language: WorkspaceLanguage | null
  name: string
  path: string
}

export interface WorkerRow {
  avatar: string | null
  id: string
  workspace_id: string
  name: string
  description: string | null
  manual_stop: number | null
  role: WorkerRole
}

export interface WorkspaceSummaryRow extends WorkspaceRow {}

export const getOrchestratorId = (workspaceId: string) => `${workspaceId}:orchestrator`

export const createOrchestrator = (
  workspaceId: string,
  language: WorkspaceLanguage = 'zh'
): AgentSummary => ({
  id: getOrchestratorId(workspaceId),
  workspaceId,
  name: 'Orchestrator',
  description: getDefaultRoleDescription('orchestrator', language),
  role: 'orchestrator',
  status: 'stopped',
  pendingTaskCount: 0,
})

export const isWorkerAgent = (
  agent: AgentSummary
): agent is AgentSummary & { role: WorkerRole } => {
  return agent.role !== 'orchestrator'
}

export const getStatusFromPendingCount = (pendingTaskCount: number): AgentStatus => {
  return pendingTaskCount > 0 ? 'working' : 'idle'
}

export const applyPendingTaskCount = (
  worker: AgentSummary & { role: WorkerRole },
  type: MessageKindRecord['type'],
  preserveStoppedStatus: boolean
) => {
  worker.pendingTaskCount =
    type === 'send' ? worker.pendingTaskCount + 1 : Math.max(0, worker.pendingTaskCount - 1)
  if (!preserveStoppedStatus) {
    worker.status = getStatusFromPendingCount(worker.pendingTaskCount)
  }
}
