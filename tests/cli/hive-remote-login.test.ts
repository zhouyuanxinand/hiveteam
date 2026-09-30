import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, expect, test } from 'vitest'

import { createGatewayServer } from '../../gateway/src/server.js'
import { createAppStateStore } from '../../src/server/app-state-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'

const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const cli = fileURLToPath(new URL('../../src/cli/hive.ts', import.meta.url))
const cleanups: Array<() => Promise<void>> = []
const remoteKeys = [
  'remote_gateway_url',
  'remote_daemon_id',
  'remote_daemon_token',
  'remote_enabled',
] as const

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const createDirectory = () => {
  const parent = resolve(tmpdir())
  const root = mkdtempSync(join(parent, 'hiveteam-remote-login-'))
  cleanups.push(async () => {
    if (dirname(resolve(root)) !== parent) throw new Error('Unexpected test directory')
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return root
}

const readRemoteConfig = (dataDir: string) => {
  const db = openRuntimeDatabase(dataDir)
  try {
    const store = createAppStateStore(db)
    return Object.fromEntries(remoteKeys.map((key) => [key, store.get(key)?.value ?? null]))
  } finally {
    db.close()
  }
}

const writeRemoteConfig = (dataDir: string, values: Record<string, string>) => {
  const db = openRuntimeDatabase(dataDir)
  try {
    const store = createAppStateStore(db)
    for (const [key, value] of Object.entries(values)) store.set(key, value)
  } finally {
    db.close()
  }
}

const startCli = (dataDir: string, args: string[]) => {
  const child = spawn(process.execPath, ['--import', loader, cli, 'remote', ...args], {
    env: { ...process.env, HIVE_DATA_DIR: dataDir, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 20_000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const completed = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveCompleted, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolveCompleted({ code, stdout, stderr }))
    }
  )
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await completed
  })
  const waitForApprovalUrl = () =>
    new Promise<URL>((resolveUrl, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        child.stdout.off('data', inspect)
        child.off('close', onClose)
        child.off('error', onError)
      }
      const inspect = () => {
        const match = stdout.match(/^\s+(http:\/\/127\.0\.0\.1:\d+\/daemon\/approve\?code=\S+)/m)
        if (!match?.[1]) return
        cleanup()
        resolveUrl(new URL(match[1]))
      }
      const onClose = () => {
        cleanup()
        reject(new Error(`Login ended before gateway approval: ${stderr}`))
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for gateway approval URL'))
      }, 15_000)
      child.stdout.on('data', inspect)
      child.once('close', onClose)
      child.once('error', onError)
      inspect()
    })
  return { completed, waitForApprovalUrl }
}

const startGateway = async (root: string) => {
  const ownerToken = 'owner-token-for-remote-login-tests'
  const gateway = createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: join(root, 'gateway'),
    ownerToken,
  })
  await gateway.start()
  cleanups.push(() => gateway.close())
  return { baseUrl: `http://${gateway.host}:${gateway.port}`, ownerToken }
}

const approve = async (url: URL, ownerToken: string) => {
  const response = await fetch(new URL('/daemon/approve', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: url.searchParams.get('code'), token: ownerToken }),
  })
  expect(response.status).toBe(200)
}

test('fresh login requires an explicit gateway and leaves remote access unconfigured', async () => {
  const dataDir = join(createDirectory(), 'runtime')
  const status = await startCli(dataDir, ['status']).completed
  expect(status.code).toBe(0)
  expect(status.stderr).toBe('')
  expect(status.stdout).toContain('Remote access: disabled')
  expect(status.stdout).toContain('hive remote login --gateway https://your-gateway.example')
  const result = await startCli(dataDir, ['login']).completed

  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('No remote gateway is configured')
  expect(result.stderr).toContain('hive remote login --gateway https://your-gateway.example')
  expect(readRemoteConfig(dataDir)).toEqual(
    Object.fromEntries(remoteKeys.map((key) => [key, null]))
  )
})

test('real gateway approval persists an explicit address and reuses it for subsequent logins', async () => {
  const root = createDirectory()
  const dataDir = join(root, 'runtime')
  const gateway = await startGateway(root)
  const previous = {
    remote_gateway_url: 'https://previous-gateway.invalid',
    remote_daemon_id: 'previous-daemon',
    remote_daemon_token: 'previous-token',
    remote_enabled: 'false',
  }
  writeRemoteConfig(dataDir, previous)

  const login = startCli(dataDir, ['login', '--gateway', gateway.baseUrl])
  const approvalUrl = await login.waitForApprovalUrl()
  expect(approvalUrl.origin).toBe(gateway.baseUrl)
  expect(readRemoteConfig(dataDir)).toEqual(previous)
  await approve(approvalUrl, gateway.ownerToken)
  const result = await login.completed
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  const saved = readRemoteConfig(dataDir)
  expect(saved).toMatchObject({
    remote_gateway_url: gateway.baseUrl,
    remote_daemon_id: expect.any(String),
    remote_daemon_token: expect.any(String),
    remote_enabled: 'true',
  })
  expect(saved.remote_daemon_id).not.toBe(previous.remote_daemon_id)
  expect(saved.remote_daemon_token).not.toBe(previous.remote_daemon_token)
  expect(result.stdout).not.toContain(saved.remote_daemon_token)

  const relogin = startCli(dataDir, ['login'])
  const nextApprovalUrl = await relogin.waitForApprovalUrl()
  expect(nextApprovalUrl.origin).toBe(gateway.baseUrl)
  expect(readRemoteConfig(dataDir)).toEqual(saved)
  await approve(nextApprovalUrl, gateway.ownerToken)
  const nextResult = await relogin.completed
  expect(nextResult.code).toBe(0)
  expect(nextResult.stderr).toBe('')
  const nextSaved = readRemoteConfig(dataDir)
  expect(nextSaved.remote_gateway_url).toBe(gateway.baseUrl)
  expect(nextSaved.remote_enabled).toBe('true')
  expect(nextSaved.remote_daemon_token).not.toBe(saved.remote_daemon_token)
  expect(nextResult.stdout).not.toContain(nextSaved.remote_daemon_token)
})

test('an explicit gateway failure retains the previously stored address and credentials', async () => {
  const root = createDirectory()
  const dataDir = join(root, 'runtime')
  const gateway = await startGateway(root)
  const previous = {
    remote_gateway_url: gateway.baseUrl,
    remote_daemon_id: 'saved-daemon',
    remote_daemon_token: 'saved-token',
    remote_enabled: 'true',
  }
  writeRemoteConfig(dataDir, previous)

  const result = await startCli(dataDir, ['login', '--gateway', `${gateway.baseUrl}/missing`])
    .completed
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('gateway /daemon/code failed: 404')
  expect(readRemoteConfig(dataDir)).toEqual(previous)
})
