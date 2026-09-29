// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useAgentConversation } from '../../web/src/terminal/useAgentConversation.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const state = (id: string) => ({
  status: 'ready',
  session_id: id,
  turns: [{ id, prompt: 'Question', process: [], answer: id, status: 'complete' }],
  truncated: false,
})
test('isolates completion records by member and ignores late responses from the previous member', async () => {
  const pending = new Map<string, (response: Response) => void>()
  vi.stubGlobal(
    'fetch',
    (url: string) => new Promise<Response>((resolve) => pending.set(url, resolve))
  )
  const view = renderHook(({ member }) => useAgentConversation('process-state', member, 'run'), {
    initialProps: { member: 'first' },
  })
  view.rerender({ member: 'second' })
  await act(async () => {
    pending.get('/api/ui/workspaces/process-state/agents/second/conversation?run_id=run')?.(
      Response.json(state('second'))
    )
  })
  await waitFor(() => expect(view.result.current.data?.session_id).toBe('second'))
  await act(async () => {
    pending.get('/api/ui/workspaces/process-state/agents/first/conversation?run_id=run')?.(
      Response.json(state('first'))
    )
  })
  expect(view.result.current.data?.session_id).toBe('second')
})
test('reuses records on reopen but not across runtime runs', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json(state('cached'))))
  const initial = renderHook(() => useAgentConversation('process-cache', 'member', 'original'))
  await waitFor(() => expect(initial.result.current.data?.session_id).toBe('cached'))
  initial.unmount()
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
  const reopened = renderHook(({ run }) => useAgentConversation('process-cache', 'member', run), {
    initialProps: { run: 'original' },
  })
  expect(reopened.result.current.data?.session_id).toBe('cached')
  reopened.rerender({ run: 'different' })
  expect(reopened.result.current.data).toBeUndefined()
})
test('reports transport failure and recovers through a real retry', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 500 })))
  const view = renderHook(() => useAgentConversation('process-retry', 'member', 'run'))
  await waitFor(() => expect(view.result.current.failed).toBe(true))
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json(state('recovered'))))
  act(() => view.result.current.retry())
  await waitFor(() => expect(view.result.current.data?.session_id).toBe('recovered'))
  expect(view.result.current.failed).toBe(false)
})

test('only visible agent terminals poll and every request names its current run', async () => {
  const requested: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    requested.push(url)
    return Promise.resolve(Response.json(state('owned')))
  })
  const view = renderHook(
    ({ enabled }) => useAgentConversation('owned-workspace', 'owned-agent', 'new run', enabled),
    {
      initialProps: { enabled: false },
    }
  )
  expect(requested).toEqual([])
  view.rerender({ enabled: true })
  await waitFor(() => expect(view.result.current.data?.session_id).toBe('owned'))
  expect(requested).toEqual([
    '/api/ui/workspaces/owned-workspace/agents/owned-agent/conversation?run_id=new%20run',
  ])
})
