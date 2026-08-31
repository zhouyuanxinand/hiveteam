import type { Database } from 'better-sqlite3'
import type { AgentSummary, WorkspaceLanguage } from '../shared/types.js'
import { getDefaultRoleDescription, getLocalizedAgentDescription } from './role-templates.js'
import type { WorkspaceRecord } from './workspace-store-contract.js'
import {
  applyPendingTaskCount,
  createOrchestrator,
  isWorkerAgent,
  type MessageKindRecord,
  type WorkerRow,
  type WorkspaceRow,
  type WorkspaceSummaryRow,
} from './workspace-store-support.js'

const createWorkerSummary = (
  workspaceId: string,
  row: Pick<WorkerRow, 'avatar' | 'description' | 'id' | 'name' | 'role'>,
  language: WorkspaceLanguage
): AgentSummary => ({
  ...(row.avatar ? { avatar: row.avatar } : {}),
  id: row.id,
  workspaceId,
  name: row.name,
  description: getLocalizedAgentDescription(
    {
      description: row.description ?? getDefaultRoleDescription(row.role, 'zh'),
      role: row.role,
    },
    language
  ),
  role: row.role,
  status: 'stopped',
  pendingTaskCount: 0,
})

const applyMessageKinds = (
  workspaces: Map<string, WorkspaceRecord>,
  messageKinds: MessageKindRecord[],
  workspaceId?: string
) => {
  for (const row of messageKinds) {
    if (workspaceId && row.workspace_id !== workspaceId) {
      continue
    }

    const worker = workspaces
      .get(row.workspace_id)
      ?.agents.find((agent) => agent.id === row.worker_id)
    if (!worker || !isWorkerAgent(worker)) {
      continue
    }

    applyPendingTaskCount(worker, row.type, true)
  }
}

export const hydrateWorkspaceFromDb = (
  db: Database,
  workspaces: Map<string, WorkspaceRecord>,
  messageKinds: MessageKindRecord[],
  workspaceId: string
) => {
  if (workspaces.has(workspaceId)) {
    return
  }

  const row = db
    .prepare('SELECT id, name, path, auto_resume, language FROM workspaces WHERE id = ?')
    .get(workspaceId) as WorkspaceSummaryRow | undefined
  if (!row) {
    return
  }

  const language: WorkspaceLanguage = row.language === 'en' ? 'en' : 'zh'
  workspaces.set(row.id, {
    autoResumeOnRestart: row.auto_resume !== 0,
    manualStoppedAgentIds: new Set<string>(),
    summary: { id: row.id, language, name: row.name, path: row.path },
    agents: [createOrchestrator(row.id, language)],
  })

  for (const workerRow of db
    .prepare(
      'SELECT id, workspace_id, name, avatar, description, manual_stop, role FROM workers WHERE workspace_id = ? ORDER BY created_at ASC'
    )
    .all(workspaceId) as WorkerRow[]) {
    workspaces
      .get(workspaceId)
      ?.agents.push(createWorkerSummary(workerRow.workspace_id, workerRow, language))
    if (workerRow.manual_stop === 1) {
      workspaces.get(workspaceId)?.manualStoppedAgentIds?.add(workerRow.id)
    }
  }

  applyMessageKinds(workspaces, messageKinds, workspaceId)
}

export const seedWorkspacesFromDb = (
  db: Database,
  workspaces: Map<string, WorkspaceRecord>,
  messageKinds: MessageKindRecord[]
) => {
  for (const row of db
    .prepare('SELECT id, name, path, auto_resume, language FROM workspaces ORDER BY created_at ASC')
    .all() as WorkspaceRow[]) {
    const language: WorkspaceLanguage = row.language === 'en' ? 'en' : 'zh'
    workspaces.set(row.id, {
      autoResumeOnRestart: row.auto_resume !== 0,
      manualStoppedAgentIds: new Set<string>(),
      summary: { id: row.id, language, name: row.name, path: row.path },
      agents: [createOrchestrator(row.id, language)],
    })
  }

  for (const row of db
    .prepare(
      'SELECT id, workspace_id, name, avatar, description, manual_stop, role FROM workers ORDER BY created_at ASC'
    )
    .all() as WorkerRow[]) {
    const language = workspaces.get(row.workspace_id)?.summary.language ?? 'zh'
    workspaces
      .get(row.workspace_id)
      ?.agents.push(createWorkerSummary(row.workspace_id, row, language))
    if (row.manual_stop === 1) {
      workspaces.get(row.workspace_id)?.manualStoppedAgentIds?.add(row.id)
    }
  }

  applyMessageKinds(workspaces, messageKinds)
}
