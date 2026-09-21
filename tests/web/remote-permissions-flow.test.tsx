// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RemoteDevicePermissions } from '../../web/src/remote/RemoteDevicePermissions.js'
import { RemotePermissionStatus } from '../../web/src/remote/RemotePermissionStatus.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const nativeFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__
})

test('desktop UI selects read scope, approves a real device request, and revokes its grant', async () => {
  const server = await startTestServer()
  try {
    const workspace = server.store.createWorkspace(server.dataDir, 'Scoped project')
    const device = server.store.remote.devices.insert({
      id: randomUUID(),
      name: 'Test phone',
      keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
      devicePublicKey: new Uint8Array(32).fill(3),
    })
    const cookie = await getUiCookie(server.baseUrl)
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
    })
    render(<RemoteDevicePermissions device={device} />)
    fireEvent.click(screen.getByText('Access for Test phone'))
    const checkbox = await screen.findByRole('checkbox', { name: 'Scoped project' })
    await waitFor(() => expect(checkbox).toBeEnabled())
    expect(server.store.remote.permissions.getAccess(device.id).workspace_ids).toEqual([])
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: 'Save read access' }))
    await waitFor(() =>
      expect(server.store.remote.permissions.getAccess(device.id).workspace_ids).toEqual([
        workspace.id,
      ])
    )
    const response = await nativeFetch(`${server.baseUrl}/api/remote/access-requests`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hive-remote-secret': server.store.getRemoteTunnelSecret(),
        'x-hive-remote-device': device.id,
      },
      body: JSON.stringify({
        workspace_id: workspace.id,
        actions: ['task_write'],
        duration_ms: 60_000,
      }),
    })
    expect(response.status).toBe(201)
    expect(server.store.remote.permissions.getAccess(device.id).grants).toEqual([])
    cleanup()
    render(<RemoteDevicePermissions device={device} />)
    fireEvent.click(screen.getByText('Access for Test phone'))
    fireEvent.click(await screen.findByRole('button', { name: 'Approve request' }))
    await screen.findByRole('button', { name: 'Revoke now' })
    const granted = server.store.remote.permissions.getAccess(device.id)
    expect(granted.grants).toHaveLength(1)
    expect(granted.grants[0]?.actions).toEqual(['task_write'])
    expect(granted.grants[0]?.workspace_id).toBe(workspace.id)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke now' }))
    await waitFor(() =>
      expect(server.store.remote.permissions.getAccess(device.id).grants).toEqual([])
    )
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke now' })).toBeNull())
  } finally {
    cleanup()
    vi.unstubAllGlobals()
    await server.close()
  }
}, 30_000)

test('remote UI submits selected actions but stays read-only while awaiting local approval', async () => {
  const server = await startTestServer()
  try {
    const workspace = server.store.createWorkspace(server.dataDir, 'Remote project')
    const device = server.store.remote.devices.insert({
      id: randomUUID(),
      name: 'Requesting phone',
      keys: { d2p: new Uint8Array(32).fill(4), p2d: new Uint8Array(32).fill(5) },
      devicePublicKey: new Uint8Array(32).fill(6),
    })
    server.store.remote.permissions.setReadScopes(device.id, [workspace.id])
    ;(window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__ = true
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('x-hive-remote-secret', server.store.getRemoteTunnelSecret())
      headers.set('x-hive-remote-device', device.id)
      return nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
    })
    render(<RemotePermissionStatus />)
    fireEvent.click(screen.getByTestId('remote-permission-status'))
    const checkbox = await screen.findByRole('checkbox', {
      name: 'Terminal input (can execute commands)',
    })
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    await screen.findByText('Request sent. Waiting for approval on the local computer.')
    expect(screen.getByTestId('remote-permission-status').textContent).toContain('Read-only access')
    const access = server.store.remote.permissions.getAccess(device.id)
    expect(access.grants).toEqual([])
    expect(access.requests).toHaveLength(1)
    expect(access.requests[0]).toMatchObject({
      workspace_id: workspace.id,
      device_id: device.id,
      actions: ['terminal_input'],
      status: 'pending',
      duration_ms: 600_000,
    })
    expect(screen.queryByRole('button', { name: 'Approve request' })).toBeNull()
  } finally {
    cleanup()
    vi.unstubAllGlobals()
    await server.close()
  }
}, 30_000)
