import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

describe('GET /api/ui/workspaces/:workspaceId/activity', () => {
  test('returns a copyable workspace activity bundle', async () => {
    const server = await startTestServer()
    servers.push(server)
    const workspace = server.store.createWorkspace(server.dataDir, 'Activity')
    const worker = server.store.addWorker(workspace.id, {
      description: 'Reviews the activity feed.',
      name: 'Reviewer',
      role: 'reviewer',
    })
    const dispatch = await server.store.dispatchTask(workspace.id, worker.id, 'Review activity')
    const cookie = await getUiCookie(server.baseUrl)

    const unauthorized = await fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/activity`)
    expect(unauthorized.status).toBe(403)

    const response = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/activity?limit=10`,
      { headers: { cookie } }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      dispatches: Array<{ id: string; state: string; text: string }>
      git: { state: string }
      messages: Array<{ text: string; type: string }>
      terminal_runs: unknown[]
      workers: Array<{ id: string; name: string; pending_task_count: number }>
      workspace: { id: string; name: string; path: string }
    }

    expect(body.workspace).toEqual({
      id: workspace.id,
      name: 'Activity',
      path: server.dataDir,
    })
    expect(body.dispatches).toEqual([
      expect.objectContaining({ id: dispatch.id, state: 'queued', text: 'Review activity' }),
    ])
    expect(body.messages).toEqual([
      expect.objectContaining({ text: 'Review activity', type: 'send' }),
    ])
    expect(body.workers).toEqual([
      expect.objectContaining({ id: worker.id, name: 'Reviewer', pending_task_count: 1 }),
    ])
    expect(body.terminal_runs).toEqual([])
    expect(body.git).toEqual(expect.objectContaining({ state: expect.any(String) }))
  })
})
