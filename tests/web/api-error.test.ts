// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest'

import { createWorkspace, startAgentRun } from '../../web/src/api.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('api error messages', () => {
  test('createWorkspace preserves server JSON error detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Workspace path does not exist: /missing' }), {
            headers: { 'content-type': 'application/json' },
            status: 400,
          })
      )
    )

    await expect(createWorkspace({ name: 'Missing', path: '/missing' })).rejects.toThrow(
      'Workspace path does not exist: /missing'
    )
  })

  test('startAgentRun preserves server JSON error detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'claude CLI not found in PATH' }), {
            headers: { 'content-type': 'application/json' },
            status: 500,
          })
      )
    )

    await expect(startAgentRun('workspace-1', 'workspace-1:orchestrator')).rejects.toThrow(
      'claude CLI not found in PATH'
    )
  })

  test('an expired UI session requires the launcher and does not retry a rejected action', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'UI endpoint requires valid UI token' }), {
          headers: { 'content-type': 'application/json' },
          status: 403,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'UI bootstrap required' }), {
          headers: { 'content-type': 'application/json' },
          status: 403,
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(startAgentRun('workspace-1', 'workspace-1:orchestrator')).rejects.toThrow(
      'Reopen Hive from its launcher'
    )

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/workspaces/workspace-1/agents/workspace-1:orchestrator/start',
      '/api/ui/session',
    ])
  })

  test('concurrent stale UI sessions share a status check and both require the launcher', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/ui/session') {
        return new Response(JSON.stringify({ error: 'UI bootstrap required' }), {
          headers: { 'content-type': 'application/json' },
          status: 403,
        })
      }
      return new Response(JSON.stringify({ error: 'UI endpoint requires valid UI token' }), {
        headers: { 'content-type': 'application/json' },
        status: 403,
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const results = await Promise.allSettled([
      startAgentRun('workspace-1', 'workspace-1:orchestrator'),
      startAgentRun('workspace-1', 'worker-a'),
    ])
    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason.message).toContain('Reopen Hive from its launcher')
      }
    }

    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/ui/session')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
