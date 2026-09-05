import type { Database } from 'better-sqlite3'

interface AgentSessionRow {
  agent_id: string
  last_session_id: string
  workspace_id: string
}

export interface AgentSessionStore {
  clearLastSessionId: (workspaceId: string, agentId: string) => void
  getLastSessionId: (workspaceId: string, agentId: string) => string | undefined
  setLastSessionId: (workspaceId: string, agentId: string, sessionId: string) => void
}

export const createAgentSessionStore = (db: Database): AgentSessionStore => {
  const lastSessionIds = new Map<string, string>()

  for (const row of db
    .prepare(
      'SELECT agent_id, workspace_id, last_session_id FROM agent_sessions ORDER BY updated_at ASC'
    )
    .all() as AgentSessionRow[]) {
    lastSessionIds.set(`${row.workspace_id}:${row.agent_id}`, row.last_session_id)
  }

  // Session ids are captured from PTY output while agents run, so these
  // statements sit on a hot path and are prepared once up front.
  const deleteSessionStmt = db.prepare(
    'DELETE FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?'
  )
  const clearWorkerSessionStmt = db.prepare(
    'UPDATE workers SET last_session_id = NULL WHERE id = ? AND workspace_id = ?'
  )
  const workerExistsStmt = db.prepare('SELECT 1 FROM workers WHERE workspace_id = ? AND id = ?')
  const workspaceExistsStmt = db.prepare('SELECT 1 FROM workspaces WHERE id = ?')
  const upsertSessionStmt = db.prepare(
    `INSERT INTO agent_sessions (agent_id, workspace_id, last_session_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       last_session_id = excluded.last_session_id,
       updated_at = excluded.updated_at`
  )
  const updateWorkerSessionStmt = db.prepare(
    'UPDATE workers SET last_session_id = ? WHERE id = ? AND workspace_id = ?'
  )
  const clearTransaction = db.transaction((workspaceId: string, agentId: string) => {
    deleteSessionStmt.run(workspaceId, agentId)
    clearWorkerSessionStmt.run(agentId, workspaceId)
  })
  const setTransaction = db.transaction(
    (
      agentId: string,
      workspaceId: string,
      sessionId: string,
      updatedAt: number,
      workerExists: boolean
    ) => {
      upsertSessionStmt.run(agentId, workspaceId, sessionId, updatedAt)
      if (workerExists) updateWorkerSessionStmt.run(sessionId, agentId, workspaceId)
    }
  )

  return {
    clearLastSessionId(workspaceId, agentId) {
      clearTransaction(workspaceId, agentId)
      lastSessionIds.delete(`${workspaceId}:${agentId}`)
    },
    getLastSessionId(workspaceId, agentId) {
      return lastSessionIds.get(`${workspaceId}:${agentId}`)
    },
    setLastSessionId(workspaceId, agentId, sessionId) {
      const updatedAt = Date.now()
      const workerExists = Boolean(workerExistsStmt.get(workspaceId, agentId))
      const isOrchestrator = agentId === `${workspaceId}:orchestrator`
      const workspaceExists = isOrchestrator && Boolean(workspaceExistsStmt.get(workspaceId))
      if (!workerExists && !workspaceExists) {
        lastSessionIds.delete(`${workspaceId}:${agentId}`)
        return
      }
      setTransaction(agentId, workspaceId, sessionId, updatedAt, workerExists)
      lastSessionIds.set(`${workspaceId}:${agentId}`, sessionId)
    },
  }
}
