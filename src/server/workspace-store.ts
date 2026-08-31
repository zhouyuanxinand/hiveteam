import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'

import type { AgentSummary, WorkspaceLanguage } from '../shared/types.js'
import { ConflictError } from './http-errors.js'
import { getDefaultRoleDescription } from './role-templates.js'
import type { WorkerInput, WorkspaceRecord, WorkspaceStore } from './workspace-store-contract.js'
import { hydrateWorkspaceFromDb, seedWorkspacesFromDb } from './workspace-store-hydration.js'
import {
  getAgentRecord,
  getWorkerByNameRecord,
  getWorkerRecord,
  isAgentManuallyStopped,
  markAgentManuallyStopped,
  markAgentStarted,
  markAgentStopped,
  markTaskCancelled,
  markTaskDispatched,
  markTaskReported,
} from './workspace-store-mutations.js'
import {
  createOrchestrator,
  isWorkerAgent,
  type MessageKindRecord,
} from './workspace-store-support.js'

export type { WorkerInput, WorkspaceRecord, WorkspaceStore }

const normalizeWorkerName = (name: string) => {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Worker name must not be empty')
  if (trimmed.length > 64) throw new Error('Worker name must be 64 characters or fewer')
  return trimmed
}

export const createWorkspaceStore = (
  db: Database,
  messageKinds: MessageKindRecord[]
): WorkspaceStore => {
  const workspaces = new Map<string, WorkspaceRecord>()
  seedWorkspacesFromDb(db, workspaces, messageKinds)

  const getWorkspace = (workspaceId: string) => {
    hydrateWorkspaceFromDb(db, workspaces, messageKinds, workspaceId)
    const workspace = workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    return workspace
  }

  return {
    addWorker(workspaceId, input) {
      const workspace = getWorkspace(workspaceId)
      const name = normalizeWorkerName(input.name)
      if (workspace.agents.some((agent) => agent.name === name && isWorkerAgent(agent))) {
        throw new ConflictError(`Worker name already exists: ${name}`)
      }
      const worker: AgentSummary = {
        ...(input.avatar ? { avatar: input.avatar } : {}),
        id: randomUUID(),
        workspaceId,
        name,
        description:
          input.description ??
          getDefaultRoleDescription(input.role, workspace.summary.language ?? 'zh'),
        role: input.role,
        status: 'stopped',
        pendingTaskCount: 0,
      }
      db.prepare(
        'INSERT INTO workers (id, workspace_id, name, avatar, description, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        worker.id,
        workspaceId,
        worker.name,
        worker.avatar ?? null,
        worker.description,
        worker.role,
        Date.now()
      )
      workspace.agents.push(worker)
      return worker
    },
    createWorkspace(path, name, language: WorkspaceLanguage = 'zh') {
      const summary = { id: randomUUID(), language, name, path }
      db.prepare(
        'INSERT INTO workspaces (id, name, path, language, auto_resume, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(summary.id, name, path, language, 1, Date.now())
      workspaces.set(summary.id, {
        autoResumeOnRestart: true,
        manualStoppedAgentIds: new Set<string>(),
        summary,
        agents: [createOrchestrator(summary.id, language)],
      })
      return summary
    },
    deleteWorkspace(workspaceId) {
      const workspace = getWorkspace(workspaceId)
      const agentIds = workspace.agents.map((agent) => agent.id)
      db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM agent_launch_configs WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ?').run(workspaceId)
        const deleteAgentRuns = db.prepare('DELETE FROM agent_runs WHERE agent_id = ?')
        for (const agentId of agentIds) deleteAgentRuns.run(agentId)
        db.prepare('DELETE FROM workers WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId)
      })()
      workspaces.delete(workspaceId)
    },
    renameWorker(workspaceId, workerId, name) {
      const worker = getWorkerRecord(workspaces, workspaceId, workerId)
      const trimmed = normalizeWorkerName(name)
      if (trimmed === worker.name) return worker
      const workspace = getWorkspace(workspaceId)
      if (
        workspace.agents.some(
          (agent) => agent.id !== workerId && agent.name === trimmed && isWorkerAgent(agent)
        )
      ) {
        throw new ConflictError(`Worker name already exists: ${trimmed}`)
      }
      db.prepare('UPDATE workers SET name = ? WHERE workspace_id = ? AND id = ?').run(
        trimmed,
        workspaceId,
        workerId
      )
      worker.name = trimmed
      return worker
    },
    setWorkerAvatar(workspaceId, workerId, avatar) {
      const worker = getWorkerRecord(workspaces, workspaceId, workerId)
      db.prepare('UPDATE workers SET avatar = ? WHERE workspace_id = ? AND id = ?').run(
        avatar,
        workspaceId,
        workerId
      )
      if (avatar) {
        worker.avatar = avatar
      } else {
        delete worker.avatar
      }
      return worker
    },
    deleteWorker(workspaceId, workerId) {
      const workspace = getWorkspace(workspaceId)
      getWorkerRecord(workspaces, workspaceId, workerId)
      db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE workspace_id = ? AND worker_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare('DELETE FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare('DELETE FROM agent_runs WHERE agent_id = ?').run(workerId)
        db.prepare('DELETE FROM workers WHERE workspace_id = ? AND id = ?').run(
          workspaceId,
          workerId
        )
      })()
      workspace.agents = workspace.agents.filter((agent) => agent.id !== workerId)
      workspace.manualStoppedAgentIds?.delete(workerId)
    },
    getAgent: (workspaceId, agentId) => getAgentRecord(workspaces, workspaceId, agentId),
    getWorker: (workspaceId, workerId) => getWorkerRecord(workspaces, workspaceId, workerId),
    getWorkerByName: (workspaceId, workerName) =>
      getWorkerByNameRecord(workspaces, workspaceId, workerName),
    getWorkspaceSnapshot: getWorkspace,
    getWorkspaceRecoverySettings(workspaceId) {
      return { autoResumeOnRestart: getWorkspace(workspaceId).autoResumeOnRestart }
    },
    hasAgent(workspaceId, agentId) {
      hydrateWorkspaceFromDb(db, workspaces, messageKinds, workspaceId)
      return workspaces.get(workspaceId)?.agents.some((agent) => agent.id === agentId) ?? false
    },
    listWorkers(workspaceId) {
      return getWorkspace(workspaceId)
        .agents.filter(isWorkerAgent)
        .map(({ avatar, id, name, role, status, pendingTaskCount }) => ({
          ...(avatar ? { avatar } : {}),
          id,
          name,
          role,
          status,
          pendingTaskCount,
        }))
    },
    listWorkspaces() {
      return Array.from(workspaces.values(), (workspace) => workspace.summary)
    },
    setAutoResumeOnRestart(workspaceId, enabled) {
      const workspace = getWorkspace(workspaceId)
      db.prepare('UPDATE workspaces SET auto_resume = ? WHERE id = ?').run(
        enabled ? 1 : 0,
        workspaceId
      )
      workspace.autoResumeOnRestart = enabled
    },
    markAgentStarted(workspaceId, agentId) {
      markAgentStarted(workspaces, workspaceId, agentId)
      db.prepare('UPDATE workers SET manual_stop = 0 WHERE workspace_id = ? AND id = ?').run(
        workspaceId,
        agentId
      )
    },
    markAgentStopped: (workspaceId, agentId) => markAgentStopped(workspaces, workspaceId, agentId),
    markAgentManuallyStopped(workspaceId, agentId) {
      markAgentManuallyStopped(workspaces, workspaceId, agentId)
      db.prepare('UPDATE workers SET manual_stop = 1 WHERE workspace_id = ? AND id = ?').run(
        workspaceId,
        agentId
      )
    },
    isAgentManuallyStopped: (workspaceId, agentId) =>
      isAgentManuallyStopped(workspaces, workspaceId, agentId),
    markTaskDispatched: (workspaceId, workerId) =>
      markTaskDispatched(workspaces, workspaceId, workerId),
    markTaskCancelled: (workspaceId, workerId) =>
      markTaskCancelled(workspaces, workspaceId, workerId),
    markTaskReported: (workspaceId, workerId) =>
      markTaskReported(workspaces, workspaceId, workerId),
  }
}
