import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionContext } from './agent-session-context.js'
import { BadRequestError, ConflictError } from './http-errors.js'
import { acquireRuntimeOwner } from './runtime-owner-lock.js'
import { hasCodexSession } from './session-capture-codex.js'
import Database from './sqlite.js'

/** Explicit, offline recovery for a native conversation whose binding was never captured. */
export const attachCodexSession = (input: {
  dataDir: string
  workspaceId: string
  agentId: string
  sessionId: string
}) => {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(input.sessionId))
    throw new BadRequestError('An explicit Codex session UUID is required.')
  const dataDir = realpathSync(input.dataDir)
  const databasePath = join(dataDir, 'runtime.sqlite')
  if (!statSync(databasePath).isFile())
    throw new BadRequestError('Existing runtime.sqlite required.')
  const owner = acquireRuntimeOwner(dataDir)
  try {
    const db = new Database(databasePath, { fileMustExist: true })
    try {
      return db.transaction(() => {
        const workspace = db
          .prepare('SELECT path FROM workspaces WHERE id=?')
          .get(input.workspaceId) as { path: string } | undefined
        const worker = db
          .prepare('SELECT last_session_id FROM workers WHERE workspace_id=? AND id=?')
          .get(input.workspaceId, input.agentId) as { last_session_id: string | null } | undefined
        if (!workspace || (!worker && input.agentId !== `${input.workspaceId}:orchestrator`))
          throw new BadRequestError('Agent not found in the specified workspace.')
        const row = db
          .prepare(
            'SELECT context_json FROM agent_session_contexts WHERE workspace_id=? AND agent_id=?'
          )
          .get(input.workspaceId, input.agentId) as { context_json: string } | undefined
        const context: AgentSessionContext | undefined = row
          ? JSON.parse(row.context_json)
          : undefined
        if (
          context?.capture?.source !== 'codex_session_jsonl_dir' ||
          context.platform !== process.platform ||
          context.cwd !== workspace.path
        )
          throw new ConflictError(
            'An existing Codex capture context matching this workspace and platform is required.'
          )
        if (!hasCodexSession(context.cwd, input.sessionId, context.capture.pattern))
          throw new ConflictError(
            'The specified native Codex session does not exist in the saved capture directory and workspace.'
          )
        if (
          db
            .prepare(
              'SELECT 1 FROM native_session_generations WHERE workspace_id=? AND agent_id=? AND current=1'
            )
            .get(input.workspaceId, input.agentId)
        )
          throw new ConflictError('This member already uses another native session binding.')
        const saved = db
          .prepare('SELECT last_session_id FROM agent_sessions WHERE workspace_id=? AND agent_id=?')
          .get(input.workspaceId, input.agentId) as { last_session_id: string } | undefined
        if (
          (saved && saved.last_session_id !== input.sessionId) ||
          (worker?.last_session_id && worker.last_session_id !== input.sessionId)
        )
          throw new ConflictError(
            'This member already has a different session binding; it has been retained.'
          )
        if (
          db
            .prepare(
              'SELECT 1 FROM agent_sessions WHERE last_session_id=? AND NOT (workspace_id=? AND agent_id=?)'
            )
            .get(input.sessionId, input.workspaceId, input.agentId) ||
          db
            .prepare(
              'SELECT 1 FROM workers WHERE last_session_id=? AND NOT (workspace_id=? AND id=?)'
            )
            .get(input.sessionId, input.workspaceId, input.agentId)
        )
          throw new ConflictError('The specified session is already bound to another member.')
        const alreadyAttached = saved?.last_session_id === input.sessionId
        if (!alreadyAttached) {
          const now = Date.now()
          db.prepare(
            'INSERT INTO agent_sessions(workspace_id,agent_id,last_session_id,updated_at) VALUES(?,?,?,?)'
          ).run(input.workspaceId, input.agentId, input.sessionId, now)
          if (worker)
            db.prepare('UPDATE workers SET last_session_id=? WHERE workspace_id=? AND id=?').run(
              input.sessionId,
              input.workspaceId,
              input.agentId
            )
          db.prepare(
            'UPDATE agent_session_contexts SET context_json=?,updated_at=? WHERE workspace_id=? AND agent_id=?'
          ).run(
            JSON.stringify({ ...context, recoveredSessionId: input.sessionId }),
            now,
            input.workspaceId,
            input.agentId
          )
        }
        return {
          state: alreadyAttached ? 'already_attached' : 'attached',
          workspace_id: input.workspaceId,
          agent_id: input.agentId,
          session_id: input.sessionId,
          native_files: 'unchanged',
        }
      })()
    } finally {
      db.close()
    }
  } finally {
    owner.close()
  }
}
