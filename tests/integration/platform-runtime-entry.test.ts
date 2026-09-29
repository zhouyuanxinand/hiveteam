import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { launchPlatform, type PlatformLaunch } from '../../scripts/platform-launch.mjs'
import { requestUiBootstrap } from '../../scripts/ui-launcher.mjs'
import { listenOnFetchSafePort } from '../helpers/test-server.js'

const require = createRequire(import.meta.url)
const platforms: PlatformLaunch[] = []
const directories: string[] = []
const entries: Array<{ child: ReturnType<typeof spawn>; closed: Promise<unknown[]> }> = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-platform-entry-'))
  directories.push(root)
  const projectRoot = join(root, 'install')
  const source = join(projectRoot, 'src/cli/hive.ts')
  const built = join(projectRoot, 'dist/src/cli/hive.js')
  for (const directory of [
    dirname(source),
    dirname(built),
    join(projectRoot, 'scripts'),
    join(projectRoot, 'node_modules'),
  ])
    mkdirSync(directory, { recursive: true })
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }))
  copyFileSync(resolve('scripts/managed-node.mjs'), join(projectRoot, 'scripts/managed-node.mjs'))
  symlinkSync(
    dirname(require.resolve('tsx/package.json')),
    join(projectRoot, 'node_modules/tsx'),
    'junction'
  )
  const service = pathToFileURL(resolve('tests/fixtures/platform-entry-service.mjs')).href
  writeFileSync(
    source,
    `import { start } from ${JSON.stringify(service)}; const entry: string = 'source'; start(entry);`
  )
  writeFileSync(built, `import { start } from ${JSON.stringify(service)}; start('built');`)
  return { projectRoot, dataDir: join(root, 'data'), source, built }
}
afterEach(async () => {
  for (const platform of platforms.splice(0)) await platform.stop()
  for (const { child, closed } of entries.splice(0)) {
    if (child.connected && child.exitCode === null && child.signalCode === null)
      child.send({ type: 'hive:shutdown' })
    await closed
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('an explicit built runtime stays built when source exists, including after recovery', async () => {
  const options = fixture()
  const platform = await launchPlatform({ ...options, runtimePort: 0, runtimeEntry: options.built })
  platforms.push(platform)
  expect(await (await fetch(platform.runtimeOrigin)).json()).toMatchObject({
    entry: 'built',
    exec_argv: [],
  })
  expect(await (await fetch(`${platform.runtimeOrigin}/launch-config`)).json()).toMatchObject({
    runtime_entry: 'built',
  })
  const oldChild = platform.supervisor.getChild('runtime')
  if (!oldChild) throw new Error('Expected runtime child')
  oldChild.kill('SIGKILL')
  await expect
    .poll(
      () =>
        platform.supervisor.getStatus().state === 'running' &&
        platform.supervisor.getChild('runtime')?.pid !== oldChild.pid,
      { timeout: 10000 }
    )
    .toBe(true)
  expect(await (await fetch(platform.runtimeOrigin)).json()).toMatchObject({
    entry: 'built',
    exec_argv: [],
  })
  expect(await (await fetch(`${platform.runtimeOrigin}/launch-config`)).json()).toMatchObject({
    runtime_entry: 'built',
  })
}, 20000)

const startConfigured = async (options: ReturnType<typeof fixture>, runtimeEntry?: string) => {
  const reservation = createServer()
  const port = await listenOnFetchSafePort(reservation)
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve()))
  )
  const config = join(options.projectRoot, 'startup.json')
  writeFileSync(
    config,
    JSON.stringify({
      project_root: options.projectRoot,
      node_executable: process.execPath,
      data_dir: options.dataDir,
      runtime_port: port,
      launch_mode: 'runtime',
      ...(runtimeEntry === undefined ? {} : { runtime_entry: runtimeEntry }),
    })
  )
  const child = spawn(
    process.execPath,
    [resolve('scripts/platform-start.mjs'), '--config', config],
    {
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
  return { child, closed, origin: `http://127.0.0.1:${port}`, output: () => output }
}

test('configured startup honors the saved built entry when source also exists', async () => {
  const entry = await startConfigured(fixture(), 'built')
  expect(await requestUiBootstrap(entry.child)).toBe('built')
  expect(await (await fetch(entry.origin)).json()).toMatchObject({ entry: 'built', exec_argv: [] })
  expect(await (await fetch(`${entry.origin}/launch-config`)).json()).toMatchObject({
    runtime_entry: 'built',
  })
})

test.each([
  'source',
  undefined,
])('configured startup uses source for entry %s', async (runtimeEntry) => {
  const entry = await startConfigured(fixture(), runtimeEntry)
  expect(await requestUiBootstrap(entry.child)).toBe('source')
  expect(await (await fetch(entry.origin)).json()).toMatchObject({
    entry: 'source',
    exec_argv: ['--import', 'tsx'],
  })
  expect(await (await fetch(`${entry.origin}/launch-config`)).json()).toMatchObject({
    runtime_entry: 'source',
  })
})

test('an explicit source entry loads TypeScript and reports the same entry to recovery', async () => {
  const options = fixture()
  const platform = await launchPlatform({
    ...options,
    runtimePort: 0,
    runtimeEntry: options.source,
  })
  platforms.push(platform)
  expect(await (await fetch(platform.runtimeOrigin)).json()).toMatchObject({
    entry: 'source',
    exec_argv: ['--import', 'tsx'],
  })
  expect(await (await fetch(`${platform.runtimeOrigin}/launch-config`)).json()).toMatchObject({
    runtime_entry: 'source',
  })
})

test('startup rejects arbitrary entry paths before starting a child', async () => {
  const options = fixture()
  for (const runtimeEntry of [resolve('src/cli/hive.ts'), 'src/cli/hive.ts'])
    await expect(launchPlatform({ ...options, runtimePort: 0, runtimeEntry })).rejects.toThrow(
      'Invalid runtime entry'
    )
  const entry = await startConfigured(options, '../other/hive.js')
  expect(await entry.closed).toEqual([1, null])
  expect(entry.output()).toContain('Invalid startup runtime_entry')
})
