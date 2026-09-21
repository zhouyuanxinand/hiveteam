// @vitest-environment jsdom

import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import Database from 'better-sqlite3'
import { afterEach, expect, test, vi } from 'vitest'
import { NativeSessionButton } from '../../web/src/worker/NativeSessionButton.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const nativeFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
test('local session controls show unverified capabilities and preserve old bindings after an explicit new generation', async () => {
  const server = await startTestServer()
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  try {
    const workspace = server.store.createWorkspace(server.dataDir, 'Session UI fixture')
    const worker = server.store.addWorker(workspace.id, {
      name: 'Synthetic member',
      role: 'reviewer',
    })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      interactiveCommand: 'agent',
    })
    db.prepare(
      'INSERT INTO agent_sessions(workspace_id,agent_id,last_session_id,updated_at) VALUES(?,?,?,?)'
    ).run(workspace.id, worker.id, 'legacy-session-fixture', Date.now())
    const cookie = await getUiCookie(server.baseUrl)
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
    })
    render(<NativeSessionButton workspaceId={workspace.id} agentId={worker.id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Session and recovery' }))
    const dialog = await screen.findByRole('dialog')
    expect(
      await within(dialog).findByText('Paused; readiness and receipts are unverified')
    ).toBeVisible()
    expect(within(dialog).getByText('Unknown')).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose a new session' }))
    const confirm = within(dialog).getByRole('button', { name: 'Confirm change' })
    expect(confirm).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Reason for change'), {
      target: { value: 'Archived the previous conversation locally' },
    })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(confirm)
    expect(await within(dialog).findByText('Not allocated')).toBeVisible()
    const view = await server.store.nativeSessions.view(workspace.id, worker.id)
    expect(view.current).toMatchObject({ generation: 2, native_id: null })
    expect(view.history[1]?.native_id).toBe('legacy-session-fixture')
    expect(view.automatic_input).toBe(false)
    expect(view.reason_code).toBe('session_adapter_unverified')
  } finally {
    cleanup()
    db.close()
    await server.close()
  }
}, 30000)

test('session details show a request error without offering a mutation on missing data', async () => {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ error: 'Session access denied' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
  )
  render(<NativeSessionButton workspaceId="workspace" agentId="worker" />)
  fireEvent.click(screen.getByRole('button', { name: 'Session and recovery' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Session access denied')
  expect(screen.queryByRole('button', { name: 'Choose a new session' })).toBeNull()
})
