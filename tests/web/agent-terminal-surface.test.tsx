// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentConversation } from '../../src/shared/agent-conversation.js'
import { AgentTerminalSurface } from '../../web/src/terminal/AgentTerminalSurface.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const answer = (text: string): AgentConversation => ({
  status: 'ready',
  session_id: 'session',
  truncated: false,
  turns: [
    {
      id: 'turn',
      prompt: 'Question',
      process: [{ id: 'p', kind: 'tool', text: 'exec_command' }],
      answer: text,
      status: 'complete',
    },
  ],
})
const props = {
  workspaceId: 'workspace',
  agentId: 'member',
  runId: 'surface-test',
  slot: 'worker' as const,
}

test('automatically presents the completed answer but preserves an explicit terminal selection', async () => {
  let resolve: (response: Response) => void = () => {}
  vi.stubGlobal(
    'fetch',
    () =>
      new Promise<Response>((done) => {
        resolve = done
      })
  )
  const view = render(<AgentTerminalSurface {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Terminal / input' }))
  resolve(Response.json(answer('Result one')))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Terminal / input' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  )
  expect(screen.queryByText('Result one')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }))
  await waitFor(() => expect(screen.getByText('Result one')).toBeVisible())
  expect(view.container.querySelector('details')?.open).toBe(false)
  const host = document.getElementById('worker-pty-surface-test')
  expect(host).not.toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Terminal / input' }))
  expect(document.getElementById('worker-pty-surface-test')).toBe(host)
  expect(host).toBeVisible()
})

test('shows cached answers on reopen without leaking them to another member or run', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json(answer('Cached member answer'))))
  const attributes = { ...props, runId: 'cache-test' }
  const initial = render(<AgentTerminalSurface {...attributes} />)
  await waitFor(() => expect(screen.getByText('Cached member answer')).toBeVisible())
  initial.unmount()
  // Pending transport must not blank an already read conversation.
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
  const reopened = render(<AgentTerminalSurface {...attributes} />)
  expect(screen.getByText('Cached member answer')).toBeVisible()
  reopened.rerender(<AgentTerminalSurface {...attributes} agentId="other" />)
  expect(screen.queryByText('Cached member answer')).toBeNull()
  reopened.rerender(<AgentTerminalSurface {...attributes} runId="new-run" />)
  expect(screen.queryByText('Cached member answer')).toBeNull()
})

test('shows running process records immediately without waiting for terminal history or a final answer', async () => {
  const body = answer('')
  body.turns = body.turns.map((turn) => ({ ...turn, status: 'running' }))
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json(body)))
  const view = render(<AgentTerminalSurface {...props} runId="running-test" />)
  await waitFor(() => expect(screen.getByText('exec_command')).toBeVisible())
  expect(view.container.querySelector('details')?.open).toBe(true)
  expect(document.getElementById('worker-pty-running-test')).not.toBeVisible()
})

test('discards late responses for the previously selected member', async () => {
  const pending = new Map<string, (response: Response) => void>()
  vi.stubGlobal(
    'fetch',
    (url: string) => new Promise<Response>((resolve) => pending.set(url, resolve))
  )
  const view = render(<AgentTerminalSurface {...props} runId="late-test" agentId="first" />)
  view.rerender(<AgentTerminalSurface {...props} runId="late-test" agentId="second" />)
  pending.get('/api/ui/workspaces/workspace/agents/second/conversation')?.(
    Response.json(answer('Current result'))
  )
  await waitFor(() => expect(screen.getByText('Current result')).toBeVisible())
  pending.get('/api/ui/workspaces/workspace/agents/first/conversation')?.(
    Response.json(answer('Stale result'))
  )
  await waitFor(() => expect(screen.queryByText('Stale result')).toBeNull())
  expect(screen.getByText('Current result')).toBeVisible()
})

test('provides a recoverable error and leaves unsupported CLIs in the original terminal', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 500 })))
  const view = render(<AgentTerminalSurface {...props} runId="error-test" />)
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded'))
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json(answer('Recovered result'))))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(screen.getByText('Recovered result')).toBeVisible())
  view.unmount()
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      Response.json({ status: 'unsupported', session_id: null, turns: [], truncated: false })
    )
  )
  render(<AgentTerminalSurface {...props} runId="unsupported-test" />)
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Conversation' })).toBeNull())
  expect(document.getElementById('worker-pty-unsupported-test')).toBeVisible()
})
