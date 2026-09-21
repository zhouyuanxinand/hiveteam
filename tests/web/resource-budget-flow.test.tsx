// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ResourceStatusButton } from '../../web/src/resources/ResourceStatusButton.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const nativeFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('resource UI edits real limits, counts idle PTYs and stops a holder without deleting its membership', async () => {
  const server = await startAuthorizedTestServer()
  try {
    const workspace = server.store.createWorkspace(server.dataDir, 'Budget workspace')
    const worker = server.store.addWorker(workspace.id, { name: 'Budget holder', role: 'reviewer' })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write('ready'); process.stdin.resume(); setInterval(() => {}, 1000)",
      ],
    })
    const run = await server.store.startAgent(workspace.id, worker.id, {
      hivePort: new URL(server.baseUrl).port,
    })
    expect(server.store.getWorker(workspace.id, worker.id).status).toBe('idle')
    const cookie = await getUiCookie(server.baseUrl)
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
    })
    render(<ResourceStatusButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Runtime resources' }))
    await screen.findByText('Global execution usage: 1 / 8')
    const total = screen.getByRole('spinbutton', { name: 'Global execution limit' })
    fireEvent.change(total, { target: { value: '0' } })
    expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled()
    fireEvent.change(total, { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }))
    await screen.findByText('Global execution usage: 1 / 1')
    expect(server.store.resources.getLimits().max_running_total).toBe(1)
    expect(server.store.getLiveRun(run.runId).status).not.toBe('exited')
    fireEvent.click(screen.getByRole('button', { name: 'Stop Budget holder' }))
    await screen.findByText('Global execution usage: 0 / 1', {}, { timeout: 6000 })
    await waitFor(() => expect(server.store.getLiveRun(run.runId).status).toBe('exited'))
    expect(server.store.listWorkers(workspace.id)).toHaveLength(1)
    expect(server.store.resources.getSnapshot().reservations).toEqual([])
  } finally {
    cleanup()
    vi.unstubAllGlobals()
    await server.close()
  }
}, 30_000)
