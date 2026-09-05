// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { useWorkspaceWorkers } from '../../web/src/useWorkspaceWorkers.js'

const json = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as Response

const ALICE = { id: 'wa', name: 'Alice', role: 'coder', status: 'working', pending_task_count: 1 }
const BOB = { id: 'wb', name: 'Bob', role: 'tester', status: 'idle', pending_task_count: 0 }

const bulkTeamPayload = (entries: Record<string, unknown[]>) => ({
  workers_by_workspace_id: entries,
})

// The hook polls one bulk endpoint for all workspaces; dispatch on the
// workspace_ids query parameter.
const stubBulkTeamFetch = () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith('/api/ui/team')) {
      const ids = new URL(url, 'http://localhost').searchParams.get('workspace_ids')?.split(',')
      const entries: Record<string, unknown[]> = {}
      if (ids?.includes('a')) entries.a = [ALICE]
      if (ids?.includes('b')) entries.b = [BOB]
      return json(bulkTeamPayload(entries))
    }
    throw new Error(`Unexpected fetch ${url}`)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useWorkspaceWorkers', () => {
  test('loads worker summaries for every local workspace id, not only the active workspace', async () => {
    stubBulkTeamFetch()

    const { result } = renderHook(() => useWorkspaceWorkers(['a', 'b']))

    await waitFor(() => {
      expect(result.current[0]).toEqual({
        a: [
          {
            id: 'wa',
            lastPtyLine: undefined,
            name: 'Alice',
            pendingTaskCount: 1,
            role: 'coder',
            status: 'working',
          },
        ],
        b: [
          {
            id: 'wb',
            lastPtyLine: undefined,
            name: 'Bob',
            pendingTaskCount: 0,
            role: 'tester',
            status: 'idle',
          },
        ],
      })
    })
  })

  test('prunes worker summaries when a workspace is removed from the local list', async () => {
    stubBulkTeamFetch()

    const { rerender, result } = renderHook(
      ({ workspaceIds }: { workspaceIds: string[] }) => useWorkspaceWorkers(workspaceIds),
      {
        initialProps: { workspaceIds: ['a', 'b'] },
      }
    )

    await waitFor(() => {
      expect(result.current[0]).toHaveProperty('a')
      expect(result.current[0]).toHaveProperty('b')
    })

    rerender({ workspaceIds: ['b'] })

    await waitFor(() => {
      expect(result.current[0]).toEqual({
        b: [
          {
            id: 'wb',
            lastPtyLine: undefined,
            name: 'Bob',
            pendingTaskCount: 0,
            role: 'tester',
            status: 'idle',
          },
        ],
      })
    })
  })

  test('keeps the same workspace map reference when refreshed worker payloads are unchanged', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue(
      json(
        bulkTeamPayload({
          a: [{ id: 'wa', name: 'Alice', role: 'coder', status: 'idle', pending_task_count: 0 }],
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useWorkspaceWorkers(['a']))

    await act(async () => {
      await flushPromises()
    })
    expect(result.current[0]).toHaveProperty('a')
    const firstMap = result.current[0]

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current[0]).toBe(firstMap)
  })

  test('backs off failed refreshes and does not overlap in-flight worker requests', async () => {
    vi.useFakeTimers()
    let resolveFirstFetch: ((response: Response) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirstFetch = resolve
          })
      )
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(
        json(
          bulkTeamPayload({
            a: [{ id: 'wa', name: 'Alice', role: 'coder', status: 'idle', pending_task_count: 0 }],
          })
        )
      )
    vi.stubGlobal('fetch', fetchMock)

    renderHook(() => useWorkspaceWorkers(['a']))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstFetch?.(json(bulkTeamPayload({ a: [] })))
      await flushPromises()
    })

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      await flushPromises()
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
