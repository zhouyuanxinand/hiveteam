import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import type { PlatformRecoveryView } from '../../src/shared/platform-recovery.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const platform = vi.hoisted(() => ({ enabled: false, supported: true, error: '' }))
vi.mock('../../src/server/platform-recovery.js', async () => {
  const { ConflictError } = await import('../../src/server/http-errors.js')
  const view = (): PlatformRecoveryView => ({
    managed: true,
    supervision: {
      state: 'running',
      restart_count: 2,
      last_error: null,
      children: [{ name: 'runtime', pid: 123 }],
    },
    auto_start: { supported: platform.supported, enabled: platform.enabled, platform: 'win32' },
  })
  return {
    getPlatformRecoveryStatus: async () => view(),
    setPlatformAutostart: async (enabled: boolean) => {
      if (!platform.supported || platform.error)
        throw new ConflictError(platform.error || 'Unsupported platform')
      platform.enabled = enabled
      return view()
    },
  }
})
const servers: Awaited<ReturnType<typeof startTestServer>>[] = []
beforeEach(() => {
  platform.enabled = false
  platform.supported = true
  platform.error = ''
})
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})
const setup = async () => {
  const server = await startTestServer()
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  const get = () => fetch(`${server.baseUrl}/api/ui/platform/recovery`, { headers: { cookie } })
  const put = (body: unknown) =>
    fetch(`${server.baseUrl}/api/ui/platform/recovery/autostart`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { server, cookie, get, put }
}

test('local platform recovery GET reports actual disabled startup and PUT persists only the requested boolean', async () => {
  const f = await setup()
  const initial = await f.get()
  expect(initial.status).toBe(200)
  expect(initial.headers.get('cache-control')).toBe('no-store')
  expect(await initial.json()).toEqual({
    managed: true,
    supervision: {
      state: 'running',
      restart_count: 2,
      last_error: null,
      children: [{ name: 'runtime', pid: 123 }],
    },
    auto_start: { supported: true, enabled: false, platform: 'win32' },
  })
  for (const enabled of [true, false]) {
    const changed = await f.put({ enabled })
    expect(changed.status).toBe(200)
    expect(changed.headers.get('cache-control')).toBe('no-store')
    expect(await changed.json()).toMatchObject({ auto_start: { enabled } })
    expect(await (await f.get()).json()).toMatchObject({ auto_start: { enabled } })
  }
})

test('recovery routes reject unauthenticated, agent and authenticated remote callers without changing platform settings', async () => {
  const f = await setup()
  const device = f.server.store.remote.devices.insert({
    id: randomUUID(),
    name: 'Remote phone',
    keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
    devicePublicKey: new Uint8Array(32).fill(3),
  })
  const remote = stampLoopbackHeaders({}, f.server.store.getRemoteTunnelSecret(), device.id)
  for (const headers of [
    {},
    remote,
    { ...remote, cookie: f.cookie },
    { 'x-hive-agent-id': 'agent', 'x-hive-agent-token': 'invalid' },
  ]) {
    const read = await fetch(`${f.server.baseUrl}/api/ui/platform/recovery`, { headers })
    expect(read.status).toBe(403)
    expect(await read.text()).not.toContain('restart_count')
    const write = await fetch(`${f.server.baseUrl}/api/ui/platform/recovery/autostart`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(write.status).toBe(403)
  }
  expect(await (await f.get()).json()).toMatchObject({ auto_start: { enabled: false } })
})

test('invalid bodies, unsupported systems and OS registration errors preserve the current startup setting', async () => {
  const f = await setup()
  for (const body of [
    null,
    [],
    {},
    true,
    { enabled: 'true' },
    { enabled: 1 },
    { enabled: true, command: 'arbitrary' },
  ]) {
    expect((await f.put(body)).status).toBe(400)
    expect(await (await f.get()).json()).toMatchObject({ auto_start: { enabled: false } })
  }
  platform.supported = false
  expect((await f.put({ enabled: true })).status).toBe(409)
  expect(await (await f.get()).json()).toMatchObject({
    auto_start: { enabled: false, supported: false },
  })
  platform.supported = true
  platform.error = 'Operating system denied registration'
  const denied = await f.put({ enabled: true })
  expect(denied.status).toBe(409)
  expect(await denied.json()).toEqual({ error: platform.error })
  expect(await (await f.get()).json()).toMatchObject({ auto_start: { enabled: false } })
})
