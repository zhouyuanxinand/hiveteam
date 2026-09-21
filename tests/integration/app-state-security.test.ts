import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const directories: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await server.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const start = async (dataDir?: string) => {
  const server = await startTestServer(dataDir ? { dataDir } : {})
  servers.push(server)
  return server
}

const readPersistedState = (dataDir: string) => {
  const database = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
  try {
    return database.prepare('SELECT key, value FROM app_state ORDER BY key').all()
  } finally {
    database.close()
  }
}

describe('public app-state security boundary', () => {
  test.each([
    'desktop',
    'remote',
  ] as const)('%s cannot read or change internal configuration through generic preferences', async (principal) => {
    const server = await start()
    const cookie = await getUiCookie(server.baseUrl)
    const device = server.store.remote.devices.insert({
      id: randomUUID(),
      name: 'Synthetic test device',
      keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
      devicePublicKey: new Uint8Array(32).fill(3),
    })
    const headers =
      principal === 'desktop'
        ? { 'content-type': 'application/json', cookie }
        : stampLoopbackHeaders(
            { 'content-type': 'application/json' },
            server.store.getRemoteTunnelSecret(),
            device.id
          )
    const secret = `synthetic-daemon-secret-${randomUUID()}`
    const internal = server.store.settings.internalAppState
    internal.set('remote_daemon_token', secret)
    internal.set('remote_gateway_url', 'https://synthetic.invalid')
    internal.set('remote_enabled', 'false')
    internal.set('workspace.fixture.memory.enabled', 'false')
    internal.set('workspace.fixture.memory.dream.enabled', 'false')
    internal.set('workspace.fixture.memory.dream.last_scheduled_at', '123')
    const before = readPersistedState(server.dataDir)

    for (const key of [
      'remote_daemon_token',
      'remote_daemon_id',
      'remote_gateway_url',
      'remote_enabled',
      'workspace.fixture.memory.enabled',
      'workspace.fixture.memory.dream.enabled',
      'workspace.fixture.memory.dream.last_scheduled_at',
      'unknown_preference',
      '%72emote_daemon_token',
      'remote%5fdaemon%5ftoken',
      '%2572emote_daemon_token',
      'active_workspace_id%00',
      'active_workspace_id%2fremote_daemon_token',
    ]) {
      for (const method of ['GET', 'PUT']) {
        const response = await fetch(`${server.baseUrl}/api/settings/app-state/${key}`, {
          method,
          headers,
          ...(method === 'PUT' ? { body: JSON.stringify({ value: 'attacker-value' }) } : {}),
        })
        expect(response.status, `${principal} ${method} ${key}`).toBe(403)
        const body = await response.text()
        expect(body).not.toContain(secret)
        expect(JSON.parse(body)).toMatchObject({
          code: principal === 'desktop' ? 'app_state_key_forbidden' : 'remote_endpoint_forbidden',
        })
      }
    }
    expect(readPersistedState(server.dataDir)).toEqual(before)
    expect(server.store.remote.config.getDaemonToken()).toBe(secret)
  })

  test('a valid preference survives SQLite reopen and can be cleared', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hive-public-preferences-'))
    directories.push(directory)
    const first = await start(directory)
    const cookie = await getUiCookie(first.baseUrl)
    const workspaceId = randomUUID()
    const response = await fetch(`${first.baseUrl}/api/settings/app-state/active_workspace_id`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: workspaceId }),
    })
    expect(response.status).toBe(204)
    expect(readPersistedState(directory)).toContainEqual({
      key: 'active_workspace_id',
      value: workspaceId,
    })
    await first.close()
    servers.splice(servers.indexOf(first), 1)

    const second = await start(directory)
    const secondCookie = await getUiCookie(second.baseUrl)
    const endpoint = `${second.baseUrl}/api/settings/app-state/active_workspace_id`
    const restored = await fetch(endpoint, { headers: { cookie: secondCookie } })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toEqual({ key: 'active_workspace_id', value: workspaceId })
    const cleared = await fetch(endpoint, {
      method: 'PUT',
      headers: { cookie: secondCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: null }),
    })
    expect(cleared.status).toBe(204)
    const empty = await fetch(endpoint, { headers: { cookie: secondCookie } })
    expect(await empty.json()).toEqual({ key: 'active_workspace_id', value: null })
    expect(readPersistedState(directory)).toContainEqual({
      key: 'active_workspace_id',
      value: null,
    })
  })

  test('invalid preference payloads leave the persisted value unchanged', async () => {
    const server = await start()
    const cookie = await getUiCookie(server.baseUrl)
    server.store.settings.publicAppState.set('active_workspace_id', 'original-workspace')
    const before = readPersistedState(server.dataDir)
    for (const body of [
      null,
      {},
      { value: false },
      { value: 7 },
      { value: [] },
      { value: {} },
      { value: '' },
      { value: ' padded ' },
      { value: 'x'.repeat(257) },
    ]) {
      const response = await fetch(`${server.baseUrl}/api/settings/app-state/active_workspace_id`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'app_state_value_invalid' })
    }
    expect(readPersistedState(server.dataDir)).toEqual(before)
  })

  test('desktop remote configuration still uses its dedicated action without returning a token', async () => {
    const server = await start()
    const cookie = await getUiCookie(server.baseUrl)
    const secret = `synthetic-daemon-secret-${randomUUID()}`
    server.store.settings.internalAppState.set('remote_daemon_token', secret)
    const update = await fetch(`${server.baseUrl}/api/remote/config`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ gateway_url: 'https://configured.invalid', enabled: false }),
    })
    expect(update.status).toBe(200)
    expect(await update.json()).toMatchObject({
      enabled: false,
      gateway_url: 'https://configured.invalid',
    })
    const status = await fetch(`${server.baseUrl}/api/remote/status`, { headers: { cookie } })
    expect(status.status).toBe(200)
    const body = await status.text()
    expect(body).not.toContain(secret)
    expect(JSON.parse(body)).toMatchObject({ logged_in: true, enabled: false })
    expect(server.store.remote.config.getDaemonToken()).toBe(secret)
  })
})
