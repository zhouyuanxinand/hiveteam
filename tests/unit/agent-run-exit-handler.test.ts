import { expect, test } from 'vitest'

import { handleAgentRunExit } from '../../src/server/agent-run-exit-handler.js'
import { createAgentRunStore } from '../../src/server/agent-run-store.js'
import { createAgentSessionStore } from '../../src/server/agent-session-store.js'
import { createAgentTokenRegistry } from '../../src/server/agent-tokens.js'
import { createLiveRunRegistry } from '../../src/server/live-run-registry.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'

test.each([
  0, 1,
])('exit code %s settles the run without discarding the original native session', async (exitCode) => {
  const db = openRuntimeDatabase()
  try {
    db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
      'workspace-1',
      'Recovery',
      '/tmp/recovery',
      Date.now()
    )
    const agentId = 'workspace-1:orchestrator'
    const sessions = createAgentSessionStore(db)
    sessions.setLastSessionId('workspace-1', agentId, 'native-session-1')
    const store = createAgentRunStore(db)
    store.insertAgentRun('run-1', agentId, 100, 1, 'running')
    const registry = createLiveRunRegistry()
    registry.add({
      agentId,
      runId: 'run-1',
      pid: 1,
      startedAt: 100,
      status: 'running',
      exitCode: null,
      output: '',
    })
    registry.createExitEntry('run-1')
    const tokenRegistry = createAgentTokenRegistry()
    const context = {
      agentId,
      registry,
      store,
      sessionStore: sessions,
      tokenRegistry,
      token: tokenRegistry.issue(agentId),
      handledRunExits: new Set<string>(),
      onAgentExit: () => {},
      startConfig: { resumedSessionId: 'native-session-1' },
      workspace: { id: 'workspace-1', name: 'Recovery', path: '/tmp/recovery' },
    }
    expect(handleAgentRunExit(context, { exitCode, endedAt: 200, runId: 'run-1' })).toBe(true)
    await registry.getExitEntry('run-1')?.promise
    expect(store.listAgentRuns(agentId)).toEqual([
      expect.objectContaining({
        status: exitCode === 0 ? 'exited' : 'error',
        exitCode,
        endedAt: 200,
      }),
    ])
    expect(createAgentSessionStore(db).getLastSessionId('workspace-1', agentId)).toBe(
      'native-session-1'
    )
    expect(handleAgentRunExit(context, { exitCode, endedAt: 300, runId: 'run-1' })).toBe(false)
    expect(store.listAgentRuns(agentId)[0]?.endedAt).toBe(200)
  } finally {
    db.close()
  }
})
