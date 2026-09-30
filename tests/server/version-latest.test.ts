import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'

import { afterEach, expect, test } from 'vitest'

import {
  createVersionService,
  type VersionService,
  type VersionServiceOptions,
} from '../../src/server/version-service.js'
import { listenOnFetchSafePort, startTestServer } from '../helpers/test-server.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const startRegistry = async (version = '2.1.20') => {
  const state = {
    status: 200,
    body: JSON.stringify({ name: 'hiveteam', version }),
    paths: [] as string[],
    hold: false,
    held: [] as ServerResponse[],
  }
  const reply = (response: ServerResponse) => {
    response.writeHead(state.status, { 'content-type': 'application/json' })
    response.end(state.body)
  }
  const server = createServer((request, response) => {
    state.paths.push(request.url ?? '')
    if (state.hold) state.held.push(response)
    else reply(response)
  })
  const port = await listenOnFetchSafePort(server)
  const release = () => {
    state.hold = false
    for (const response of state.held.splice(0)) {
      if (!response.destroyed) reply(response)
    }
  }
  cleanups.push(async () => {
    release()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { state, release, url: `http://127.0.0.1:${port}` }
}

const startRuntime = async (
  registryUrl: string,
  options: Omit<VersionServiceOptions, 'registryUrl'> = {},
  wrap?: (service: VersionService) => VersionService
) => {
  const versionService = createVersionService({
    currentVersion: '2.1.19',
    registryUrl,
    ...options,
  })
  const server = await startTestServer({
    versionService: wrap ? wrap(versionService) : versionService,
  })
  cleanups.push(server.close)
  return server
}

test('local HTTP version metadata stays fast and never reads the npm registry', async () => {
  const registry = await startRegistry()
  const runtime = await startRuntime(registry.url)
  const response = await fetch(`${runtime.baseUrl}/api/version`)
  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    current_version: '2.1.19',
    install_hint: 'npm install -g hiveteam@latest',
    latest_version: '2.1.19',
    package_name: 'hiveteam',
    release_url: 'https://github.com/zhouyuanxinand/hiveteam',
    update_available: false,
  })
  expect(registry.state.paths).toEqual([])
})

test.each([
  ['2.1.20', '2.1.19', true],
  ['2.1.19', '2.1.19', false],
  ['2.1.18', '2.1.19', false],
  ['2.1.19-rc.1', '2.1.19', false],
  ['2.1.19', '2.1.19-rc.1', true],
  ['2.1.19', '2.1.20-rc.1', false],
  ['2.1.19+build.2', '2.1.19+build.1', false],
])('latest HTTP metadata compares npm %s with installed %s', async (latest, current, available) => {
  const registry = await startRegistry(latest)
  const runtime = await startRuntime(registry.url, { currentVersion: current })
  const response = await fetch(`${runtime.baseUrl}/api/version/latest`)
  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    current_version: current,
    install_hint: 'npm install -g hiveteam@latest',
    latest_version: latest,
    package_name: 'hiveteam',
    release_url: 'https://github.com/zhouyuanxinand/hiveteam',
    update_available: available,
  })
  expect(registry.state.paths).toEqual(['/hiveteam/latest'])
})

test('successful registry results stay cached for one hour without changing local metadata', async () => {
  const registry = await startRegistry('2.1.20')
  let now = 0
  const runtime = await startRuntime(registry.url, { now: () => now })
  const latest = () =>
    fetch(`${runtime.baseUrl}/api/version/latest`).then((response) => response.json())

  expect(await latest()).toMatchObject({ latest_version: '2.1.20', update_available: true })
  registry.state.body = JSON.stringify({ version: '2.1.21' })
  now = 60 * 60 * 1_000 - 1
  expect(await latest()).toMatchObject({ latest_version: '2.1.20', update_available: true })
  expect(registry.state.paths).toHaveLength(1)
  const local = await fetch(`${runtime.baseUrl}/api/version`)
  expect(await local.json()).toMatchObject({ latest_version: '2.1.19', update_available: false })
  now += 1
  expect(await latest()).toMatchObject({ latest_version: '2.1.21', update_available: true })
  expect(registry.state.paths).toHaveLength(2)
})

test('concurrent HTTP update checks share the same registry lookup', async () => {
  const registry = await startRegistry()
  registry.state.hold = true
  let calls = 0
  let reachedAll: (() => void) | undefined
  const allCalls = new Promise<void>((resolve) => {
    reachedAll = resolve
  })
  const runtime = await startRuntime(registry.url, {}, (service) => ({
    ...service,
    getLatestVersionInfo: () => {
      const result = service.getLatestVersionInfo()
      calls += 1
      if (calls === 3) reachedAll?.()
      return result
    },
  }))
  const pending = Promise.all(
    Array.from({ length: 3 }, () => fetch(`${runtime.baseUrl}/api/version/latest`))
  )
  try {
    await allCalls
    registry.release()
    const responses = await pending
    for (const response of responses) {
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        latest_version: '2.1.20',
        update_available: true,
      })
    }
    expect(registry.state.paths).toEqual(['/hiveteam/latest'])
  } finally {
    registry.release()
  }
})

test.each([
  [502, JSON.stringify({ error: 'registry unavailable' })],
  [200, JSON.stringify({ version: 'not-a-version' })],
  [200, JSON.stringify({ name: 'hiveteam' })],
  [200, 'invalid json'],
])('registry failure %s / %s returns 503 and can recover without a failed-result cache', async (status, body) => {
  const registry = await startRegistry()
  registry.state.status = status
  registry.state.body = body
  const runtime = await startRuntime(registry.url)
  const failed = await fetch(`${runtime.baseUrl}/api/version/latest`)
  expect(failed.status).toBe(503)
  expect(await failed.json()).toMatchObject({ error: expect.any(String) })
  const local = await fetch(`${runtime.baseUrl}/api/version`)
  expect(local.status).toBe(200)
  expect(await local.json()).toMatchObject({ latest_version: '2.1.19', update_available: false })
  registry.state.status = 200
  registry.state.body = JSON.stringify({ version: '2.1.20' })
  const recovered = await fetch(`${runtime.baseUrl}/api/version/latest`)
  expect(recovered.status).toBe(200)
  expect(await recovered.json()).toMatchObject({ latest_version: '2.1.20', update_available: true })
  expect(registry.state.paths).toEqual(['/hiveteam/latest', '/hiveteam/latest'])
})

test('a stalled registry lookup times out and a subsequent lookup can succeed', async () => {
  const registry = await startRegistry()
  registry.state.hold = true
  const runtime = await startRuntime(registry.url, { timeoutMs: 200 })
  try {
    const failed = await fetch(`${runtime.baseUrl}/api/version/latest`)
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({ error: 'npm version lookup timed out' })
  } finally {
    registry.release()
  }
  const recovered = await fetch(`${runtime.baseUrl}/api/version/latest`)
  expect(recovered.status).toBe(200)
  expect(await recovered.json()).toMatchObject({ latest_version: '2.1.20', update_available: true })
})

test('paired remote devices can read npm update metadata without workspace write permission', async () => {
  const registry = await startRegistry()
  const runtime = await startRuntime(registry.url)
  const device = runtime.store.remote.devices.insert({
    id: randomUUID(),
    name: 'Update-check phone',
    keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
    devicePublicKey: new Uint8Array(32).fill(3),
  })
  const response = await fetch(`${runtime.baseUrl}/api/version/latest`, {
    headers: {
      'x-hive-remote-secret': runtime.store.getRemoteTunnelSecret(),
      'x-hive-remote-device': device.id,
    },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ latest_version: '2.1.20', update_available: true })
  expect(registry.state.paths).toEqual(['/hiveteam/latest'])
})
