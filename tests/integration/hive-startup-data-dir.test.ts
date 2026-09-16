import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, test } from 'vitest'

import { getUiCookie } from '../helpers/ui-session.js'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const cliUrl = new URL('../../src/cli/hive.ts', import.meta.url).href
const require = createRequire(import.meta.url)
const tsxUrl = pathToFileURL(require.resolve('tsx')).href
const execFileAsync = promisify(execFile)
const cleanups: Array<() => Promise<void>> = []
const tempRoots: string[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

const freePort = async () => {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback port')
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  return address.port
}

const createFixture = (sourceCheckout = false) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-startup-data-dir-'))
  tempRoots.push(root)
  const installDir = join(root, 'install')
  const invocationDir = join(root, 'invocation 中文')
  const homeDir = join(root, 'home')
  for (const path of [installDir, invocationDir, homeDir]) mkdirSync(path)

  const writeFixture = (path: string, source: string) => {
    const target = join(installDir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, source)
  }
  writeFixture('package.json', JSON.stringify({ type: 'module' }))
  for (const path of [
    'scripts/dev-start.mjs',
    'desktop/app.mjs',
    'desktop/service-environment.mjs',
  ]) {
    mkdirSync(dirname(join(installDir, path)), { recursive: true })
    copyFileSync(join(projectRoot, path), join(installDir, path))
  }

  // Both entry fixtures use the real CLI, HTTP server, and SQLite store.
  // Isolate Electron's window adapter and Vite's UI; no browser or network is needed.
  writeFixture(
    sourceCheckout ? 'src/cli/hive.ts' : 'dist/src/cli/hive.js',
    `import { runHiveCommand } from ${JSON.stringify(cliUrl)};
await runHiveCommand(process.argv.slice(2));`
  )
  if (sourceCheckout) {
    mkdirSync(join(installDir, 'node_modules'), { recursive: true })
    symlinkSync(
      dirname(require.resolve('tsx/package.json')),
      join(installDir, 'node_modules/tsx'),
      'junction'
    )
    writeFixture('node_modules/vite/package.json', '{"type":"module"}')
    writeFixture(
      'node_modules/vite/bin/vite.js',
      `import { createServer } from 'node:http';
const port = Number(process.env.HIVE_WEB_PORT);
createServer((_, response) => response.end('Startup UI fixture')).listen(port, '127.0.0.1', () => {
  console.log('http://127.0.0.1:' + port);
});`
    )
  }
  writeFixture('node_modules/electron/package.json', '{"type":"module","exports":"./index.mjs"}')
  writeFixture(
    'node_modules/electron/index.mjs',
    `import { EventEmitter } from 'node:events';
export const session = { defaultSession: { setPermissionRequestHandler() {} } };
export const ipcMain = { removeHandler() {}, handle() {} };
export class BrowserWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  async loadURL(url) { await fetch(url); }
}`
  )
  writeFixture(
    'desktop-driver.mjs',
    `import { launchHiveDesktop, launchHiveWebHost } from './desktop/app.mjs';
const launch = process.argv[2] === 'desktop' ? launchHiveDesktop : launchHiveWebHost;
const host = await launch({ randomPorts: true, show: false, dataDir: process.argv[3] });
console.log('STARTUP_READY=' + host.runtimeOrigin);
process.stdin.once('data', async () => { await host.close(); process.stdin.destroy(); });`
  )
  return { root, installDir, invocationDir, homeDir }
}

type LaunchMode = 'cli' | 'dev' | 'desktop' | 'web'

const start = async (
  fixture: ReturnType<typeof createFixture>,
  mode: LaunchMode,
  override?: string,
  dataDirOption?: string,
  cwd = fixture.invocationDir
) => {
  const environment = { ...process.env }
  delete environment.HIVE_DATA_DIR
  delete environment.HIVE_DESKTOP_BRIDGE_TOKEN
  Object.assign(environment, {
    HOME: fixture.homeDir,
    USERPROFILE: fixture.homeDir,
    APPDATA: join(fixture.homeDir, 'appdata'),
    XDG_CONFIG_HOME: join(fixture.homeDir, 'xdg'),
    HIVE_RUNTIME_PORT: String(await freePort()),
    HIVE_WEB_PORT: String(await freePort()),
    HIVE_NODE_EXECUTABLE: process.execPath,
    NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ''} --import=${tsxUrl}`.trim(),
  })
  if (override !== undefined) environment.HIVE_DATA_DIR = override
  const args =
    mode === 'cli'
      ? [fileURLToPath(cliUrl), '--port', '0']
      : mode === 'dev'
        ? [join(fixture.installDir, 'scripts/dev-start.mjs')]
        : [
            join(fixture.installDir, 'desktop-driver.mjs'),
            mode,
            ...(dataDirOption ? [dataDirOption] : []),
          ]
  const child = spawn(process.execPath, args, {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const closed = once(child, 'close')
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (mode === 'desktop' || mode === 'web') child.stdin.end('close\n')
      else if (process.platform === 'win32' && child.pid) {
        await execFileAsync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
        })
      } else child.kill('SIGTERM')
    }
    await closed
  }
  cleanups.push(stop)
  const ready =
    mode === 'desktop' || mode === 'web'
      ? /STARTUP_READY=(http:\/\/127\.0\.0\.1:\d+)/
      : /Hive running at (http:\/\/127\.0\.0\.1:\d+)/
  await expect
    .poll(
      () => {
        if (child.exitCode !== null) throw new Error(output)
        return ready.test(output)
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  const origin = ready.exec(output)?.[1]
  if (!origin) throw new Error(output)
  const cookie = await getUiCookie(origin)
  return { origin, cookie, output: () => output, stop }
}

describe.each([
  false,
  true,
])('data directory across launchers (source checkout: %s)', (sourceCheckout) => {
  test.each([
    'default',
    'relative',
    'absolute',
  ] as const)('%s selection reopens the same SQLite state across launchers', async (selection) => {
    const fixture = createFixture(sourceCheckout)
    const override =
      selection === 'relative'
        ? './saved data/../saved 中文'
        : selection === 'absolute'
          ? join(fixture.root, 'custom 中文')
          : undefined
    const expectedDir = override
      ? resolve(fixture.invocationDir, override)
      : join(fixture.homeDir, '.config', 'hive')
    for (const mode of ['cli', 'dev', 'desktop', 'web'] as const) {
      const cwd =
        selection === 'relative' || mode === 'cli' ? fixture.invocationDir : fixture.installDir
      const runtime = await start(fixture, mode, override, undefined, cwd)
      try {
        const endpoint = `${runtime.origin}/api/settings/app-state/startup-marker`
        const headers = { cookie: runtime.cookie, 'content-type': 'application/json' }
        if (mode === 'cli') {
          const response = await fetch(endpoint, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ value: 'saved before restart' }),
          })
          expect(response.status).toBe(204)
        }
        const response = await fetch(endpoint, { headers })
        expect(response.status).toBe(200)
        expect.soft(await response.json(), `${mode} must reopen ${expectedDir}`).toMatchObject({
          key: 'startup-marker',
          value: 'saved before restart',
        })
        expect(existsSync(join(expectedDir, 'runtime.sqlite'))).toBe(true)
        expect
          .soft(existsSync(join(fixture.installDir, 'saved 中文', 'runtime.sqlite')))
          .toBe(false)
        if (override)
          expect(existsSync(join(fixture.homeDir, '.config', 'hive', 'runtime.sqlite'))).toBe(false)
        if (mode !== 'cli') {
          expect(runtime.output()).toContain(`[HiveTeam] Data directory: ${expectedDir}`)
        }
      } finally {
        await runtime.stop()
      }
    }
  }, 60_000)

  test('desktop launch option takes precedence and is resolved against the invocation directory', async () => {
    const fixture = createFixture(sourceCheckout)
    const inheritedDir = join(fixture.root, 'inherited data')
    const runtime = await start(fixture, 'web', inheritedDir, './option 中文')
    try {
      const selectedDir = join(fixture.invocationDir, 'option 中文')
      expect(existsSync(join(selectedDir, 'runtime.sqlite'))).toBe(true)
      expect(existsSync(join(inheritedDir, 'runtime.sqlite'))).toBe(false)
      expect(existsSync(join(fixture.installDir, 'option 中文', 'runtime.sqlite'))).toBe(false)
      expect(runtime.output()).toContain(`[HiveTeam] Data directory: ${selectedDir}`)
    } finally {
      await runtime.stop()
    }
  }, 30_000)
})
