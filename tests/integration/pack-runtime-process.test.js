import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import {
  captureChild,
  stopInstalledRuntime,
  stopOwnedChild,
} from '../../scripts/pack-runtime-process.mjs'
import { acquirePlatformOwner } from '../../scripts/platform-owner.mjs'

const children = []
const directories = []
const capture = (file, args) => {
  const handle = captureChild(file, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.push(handle)
  return handle
}

afterEach(async () => {
  for (const handle of children.splice(0)) await stopOwnedChild(handle)
  for (const directory of directories.splice(0))
    await rm(directory, { force: true, recursive: true })
})

const runningChild = async (exitCode) => {
  const handle = capture(process.execPath, [
    '-e',
    `process.on('SIGTERM', () => process.exit(${exitCode})); setInterval(() => {}, 1000); process.send('ready')`,
  ])
  expect(await once(handle.child, 'message')).toEqual(['ready', undefined])
  return handle
}

test('accepts a runtime that has already exited successfully', async () => {
  const handle = capture(process.execPath, ['-e', 'process.exit(0)'])
  await handle.closed
  await expect(stopInstalledRuntime(handle, { shutdownTimeoutMs: 25 })).resolves.toMatchObject({
    code: 0,
    forced: false,
  })
})

test('rejects a runtime that has already exited with an error and preserves its diagnostics', async () => {
  const handle = capture(process.execPath, [
    '-e',
    "process.stderr.write('fixture shutdown failed'); process.exit(7)",
  ])
  await handle.closed
  await expect(stopInstalledRuntime(handle, { shutdownTimeoutMs: 25 })).rejects.toThrow(
    'Packaged runtime exited with code 7\nfixture shutdown failed'
  )
})

test('preserves the original spawn error when no runtime could be started', async () => {
  const handle = capture(`${process.execPath}-missing-${crypto.randomUUID()}`, [])
  const result = await handle.closed
  expect(result.error).toMatchObject({ code: 'ENOENT' })
  await expect(stopInstalledRuntime(handle, { shutdownTimeoutMs: 25 })).rejects.toBe(result.error)
})

test.runIf(process.platform !== 'win32').each([0, 7])(
  'checks the real runtime SIGTERM handler exit code %s',
  async (exitCode) => {
    const handle = await runningChild(exitCode)
    if (exitCode === 0) {
      await expect(stopInstalledRuntime(handle, { shutdownTimeoutMs: 25 })).resolves.toMatchObject({
        code: 0,
        forced: false,
      })
    } else {
      await expect(stopInstalledRuntime(handle, { shutdownTimeoutMs: 25 })).rejects.toThrow(
        'code 7'
      )
    }
    expect(handle.child.exitCode).toBe(exitCode)
  }
)

test.runIf(process.platform === 'win32')(
  'accepts its own Windows taskkill termination after the real child has closed',
  async () => {
    const handle = await runningChild(7)
    const result = await stopInstalledRuntime(handle, { shutdownTimeoutMs: 25 })
    expect(result.forced).toBe(true)
    expect(handle.child.exitCode).not.toBeNull()
    expect(() => process.kill(handle.child.pid, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' })
    )
  }
)

test('requests IPC cleanup before terminating a platform and preserves its exit diagnostics', async () => {
  const handle = capture(process.execPath, [
    '-e',
    `process.on('message', (message) => {
      if (message.type === 'hive:shutdown') {
        process.stderr.write('fixture IPC cleanup failed'); process.exit(9)
      }
    }); setInterval(() => {}, 1000); process.send('ready')`,
  ])
  await once(handle.child, 'message')
  await expect(stopInstalledRuntime(handle)).rejects.toThrow('code 9\nfixture IPC cleanup failed')
  expect(handle.child.exitCode).toBe(9)
})

test('closes a real platform guardian, flushes its managed service, and releases the data directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-pack-platform-stop-'))
  directories.push(directory)
  const project = join(directory, 'project')
  const dataDir = join(directory, 'data')
  const log = join(directory, 'service.jsonl')
  await mkdir(join(project, 'dist', 'src', 'cli'), { recursive: true })
  await mkdir(join(project, 'scripts'))
  await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module' }))
  await copyFile(resolve('scripts/managed-node.mjs'), join(project, 'scripts', 'managed-node.mjs'))
  await copyFile(
    resolve('tests/fixtures/platform-service.mjs'),
    join(project, 'dist', 'src', 'cli', 'hive.js')
  )
  const handle = capture(process.execPath, [
    '--input-type=module',
    '-e',
    `import { runPlatformConsole } from ${JSON.stringify(pathToFileURL(resolve('scripts/platform-console.mjs')).href)};
    await runPlatformConsole({ ...${JSON.stringify({ projectRoot: project, dataDir, runtimePort: 0 })}, environment: { ...process.env, SUPERVISOR_TEST_LOG: ${JSON.stringify(log)} } });
    process.send('guardian-ready');`,
  ])
  expect(await once(handle.child, 'message')).toEqual(['guardian-ready', undefined])
  const started = JSON.parse((await readFile(log, 'utf8')).trim())
  expect(started.event).toBe('started')
  await expect(stopInstalledRuntime(handle)).resolves.toMatchObject({ code: 0, forced: false })
  const events = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(events).toEqual([
    { event: 'started', pid: started.pid },
    { event: 'shutdown', pid: started.pid },
  ])
  expect(() => process.kill(started.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  const owner = acquirePlatformOwner(dataDir)
  expect(owner.dataDir).toBe(dataDir)
  owner.close()
})
