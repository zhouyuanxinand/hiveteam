import type { SessionIdCaptureConfig } from './session-capture.js'
import type { Database } from './sqlite.js'

export interface AgentSessionContext {
  capture: SessionIdCaptureConfig
  cwd: string
  knownSessionIds: string[]
  platform: NodeJS.Platform
  /** Explicit offline recovery of an old session that never received its HiveTeam marker. */
  recoveredSessionId?: string
}

export const createAgentSessionContextStore = (db: Database) => {
  const read = db.prepare(
    'SELECT context_json FROM agent_session_contexts WHERE workspace_id = ? AND agent_id = ?'
  )
  const save = db.prepare(`
    INSERT INTO agent_session_contexts (workspace_id, agent_id, context_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
      context_json = excluded.context_json, updated_at = excluded.updated_at
  `)
  return {
    getCaptureContext(workspaceId: string, agentId: string): AgentSessionContext | undefined {
      const row = read.get(workspaceId, agentId) as { context_json: string } | undefined
      return row ? JSON.parse(row.context_json) : undefined
    },
    saveCaptureContext(workspaceId: string, agentId: string, context: AgentSessionContext) {
      save.run(workspaceId, agentId, JSON.stringify(context), Date.now())
    },
  }
}
