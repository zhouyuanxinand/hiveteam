import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { launchPlatform, type PlatformLaunch } from '../../scripts/platform-launch.mjs'
import { requestUiBootstrap } from '../../scripts/ui-launcher.mjs'
import { listenOnFetchSafePort } from '../helpers/test-server.js'

const platforms: PlatformLaunch[] = []
const directories: string[] = []
const entries: Array<{ child: ReturnType<typeof spawn>; closed: Promise<unknown[]> }> = []
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Expected platform launch test value')
  return value
}
const fixture = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-platform-launch-'))
  directories.push(dataDir)
  const workspace = join(dataDir, 'workspace')
  mkdirSync(workspace)
  return { dataDir, workspace, projectRoot: resolve('.'), runtimePort: 0 }
}
const start = async (options: Parameters<typeof launchPlatform>[0]) => {
  const platform = await launchPlatform(options)
  platforms.push(platform)
  return platform
}
const exchange = async (platform: PlatformLaunch) => {
  const launchUrl = new URL(await platform.createLaunchUrl())
  const response = await fetch(`${platform.runtimeOrigin}/api/ui/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      bootstrap_token: new URLSearchParams(launchUrl.hash.slice(1)).get('hive_bootstrap'),
    }),
  })
  expect(response.status).toBe(200)
  return required(response.headers.get('set-cookie')?.split(';')[0])
}
afterEach(async () => {
  for (const platform of platforms.splice(0)) await platform.stop()
  for (const entry of entries.splice(0)) {
    if (entry.child.exitCode === null && entry.child.signalCode === null)
      entry.child.send({ type: 'hive:shutdown' })
    await entry.closed
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('a crashed real runtime reloads its workspace and needs bootstrap from the current child', async () => {
  const options = fixture()
  const platform = await start(options)
  const oldCookie = await exchange(platform)
  const created = await fetch(`${platform.runtimeOrigin}/api/workspaces`, {
    method: 'POST',
    headers: { cookie: oldCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Crash persistence',
      path: options.workspace,
      initialization_mode: 'basic',
      autostart_orchestrator: false,
    }),
  })
  expect(created.status).toBe(201)
  const workspace = await created.json()
  const previous = required(platform.supervisor.getChild('runtime'))
  const statusBefore = await fetch(`${platform.runtimeOrigin}/api/ui/platform/recovery`, {
    headers: { cookie: oldCookie },
  })
  expect(statusBefore.status).toBe(200)
  expect(await statusBefore.json()).toMatchObject({
    managed: true,
    supervision: {
      state: 'running',
      restart_count: 0,
      children: [{ name: 'runtime', pid: previous.pid }],
    },
    auto_start: { enabled: false },
  })
  previous.kill('SIGKILL')
  await expect
    .poll(
      () =>
        platform.supervisor.getStatus().state === 'running' &&
        platform.supervisor.getChild('runtime')?.pid !== previous.pid,
      { timeout: 20000 }
    )
    .toBe(true)
  expect(previous.exitCode !== null || previous.signalCode !== null).toBe(true)
  expect(
    (await fetch(`${platform.runtimeOrigin}/api/workspaces`, { headers: { cookie: oldCookie } }))
      .status
  ).toBe(403)
  const freshCookie = await exchange(platform)
  expect(freshCookie).not.toBe(oldCookie)
  const statusAfter = await fetch(`${platform.runtimeOrigin}/api/ui/platform/recovery`, {
    headers: { cookie: freshCookie },
  })
  expect(statusAfter.status).toBe(200)
  expect(await statusAfter.json()).toMatchObject({
    managed: true,
    supervision: {
      state: 'running',
      restart_count: 1,
      children: [{ name: 'runtime', pid: platform.supervisor.getChild('runtime')?.pid }],
    },
    auto_start: { enabled: false },
  })
  const list = await fetch(`${platform.runtimeOrigin}/api/workspaces`, {
    headers: { cookie: freshCookie },
  })
  expect(list.status).toBe(200)
  expect(await list.json()).toContainEqual(
    expect.objectContaining({
      id: workspace.id,
      name: 'Crash persistence',
      path: options.workspace,
    })
  )
  expect(platform.supervisor.getStatus().restart_count).toBe(1)
}, 40000)

test('the data directory has one platform owner and becomes available after a normal stop', async () => {
  const options = fixture()
  const first = await start(options)
  const pid = first.supervisor.getChild('runtime')?.pid
  await expect(launchPlatform(options)).rejects.toMatchObject({
    name: 'PlatformAlreadyRunningError',
  })
  expect(first.supervisor.getChild('runtime')?.pid).toBe(pid)
  expect((await fetch(`${first.runtimeOrigin}/api/version`)).status).toBe(200)
  await first.stop()
  const second = await start(options)
  expect(second.supervisor.getChild('runtime')?.pid).not.toBe(pid)
  expect((await fetch(`${second.runtimeOrigin}/api/version`)).status).toBe(200)
}, 40000)

const startConfiguredEntry = (options: ReturnType<typeof fixture>, port: number) => {
  const config = join(options.dataDir, 'startup config.json')
  writeFileSync(
    config,
    JSON.stringify({
      project_root: options.projectRoot,
      node_executable: process.execPath,
      data_dir: options.dataDir,
      runtime_port: port,
      launch_mode: 'runtime',
    })
  )
  const child = spawn(
    process.execPath,
    [resolve('scripts/platform-start.mjs'), '--config', config],
    {
      env: process.env,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    }
  )
  const closed = once(child, 'close')
  entries.push({ child, closed })
  let output = ''
  child.stdout?.on('data', (chunk) => {
    output += chunk
  })
  child.stderr?.on('data', (chunk) => {
    output += chunk
  })
  return { child, closed, output: () => output }
}

test('the configured OS startup entry launches the real platform and shuts down over IPC', async () => {
  const options = fixture()
  const reservation = createServer()
  const port = await listenOnFetchSafePort(reservation)
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve()))
  )
  const entry = startConfiguredEntry(options, port)
  await expect
    .poll(
      () => {
        if (entry.child.exitCode !== null) throw new Error(entry.output())
        return entry.output().includes(`HiveTeam running at http://127.0.0.1:${port}`)
      },
      { timeout: 15000 }
    )
    .toBe(true)
  const response = await fetch(`http://127.0.0.1:${port}/api/ui/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrap_token: await requestUiBootstrap(entry.child) }),
  })
  expect(response.status).toBe(200)
  entry.child.send({ type: 'hive:shutdown' })
  expect(await entry.closed).toEqual([0, null])
  const reopened = await start(options)
  expect((await fetch(`${reopened.runtimeOrigin}/api/version`)).status).toBe(200)
}, 40000)

test('the configured startup entry rejects an invalid configuration with nonzero exit', async () => {
  const entry = startConfiguredEntry(fixture(), 0)
  const [code, signal] = await entry.closed
  expect(code).not.toBe(0)
  expect(signal).toBeNull()
  expect(entry.output()).toContain('Invalid startup runtime_port')
})
