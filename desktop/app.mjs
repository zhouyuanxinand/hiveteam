import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { BrowserWindow, ipcMain, session } from 'electron'

import { createDesktopServiceEnvironment } from './service-environment.mjs'

const PROBE_DROPPED_FOLDER_CHANNEL = 'hive-desktop:probe-dropped-folder'
const FOLDER_PROBE_TIMEOUT_MS = 10_000
const STARTUP_TIMEOUT_MS = 45_000
const execFileP = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const preloadPath = resolve(projectRoot, 'desktop', 'preload.cjs')

const readRequestedPort = (name) => {
  const rawValue = process.env[name]?.trim()
  if (!rawValue) return null
  const port = Number(rawValue)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`)
  }
  return port
}

const findFreePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a loopback port'))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })

const waitForHttp = async (url, children) => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const stoppedChild = children.find(
      (child) => child.exitCode !== null || child.signalCode !== null
    )
    if (stoppedChild) throw new Error(`HiveTeam startup process exited before ${url} was ready`)

    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) {
        const stoppedChild = children.find(
          (child) => child.exitCode !== null || child.signalCode !== null
        )
        if (stoppedChild) {
          throw new Error(`HiveTeam startup process exited while ${url} was being verified`)
        }
        return
      }
    } catch {
      // The child is still starting. Retry until the bounded deadline below.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

const pipeChildOutput = (child, label) => {
  child.stdout?.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`))
  child.stderr?.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`))
}

const waitForChildReady = (child, label, readyText) =>
  new Promise((resolveReady, rejectReady) => {
    let output = ''
    const timeout = setTimeout(() => {
      cleanup()
      rejectReady(new Error(`Timed out waiting for ${label} process readiness`))
    }, STARTUP_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout?.off('data', handleOutput)
      child.off('error', handleError)
      child.off('exit', handleExit)
    }
    const handleOutput = (chunk) => {
      output = `${output}${chunk}`.slice(-4096)
      if (!output.includes(readyText)) return
      cleanup()
      resolveReady()
    }
    const handleError = (error) => {
      cleanup()
      rejectReady(new Error(`${label} process could not start`, { cause: error }))
    }
    const handleExit = (code, signal) => {
      cleanup()
      const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
      rejectReady(new Error(`${label} process exited with ${reason} before readiness`))
    }
    child.stdout?.on('data', handleOutput)
    child.once('error', handleError)
    child.once('exit', handleExit)
  })

const waitForChildExit = (child, timeoutMs) =>
  new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit(true)
      return
    }
    const timeout = setTimeout(() => {
      child.off('exit', handleExit)
      resolveExit(false)
    }, timeoutMs)
    const handleExit = () => {
      clearTimeout(timeout)
      resolveExit(true)
    }
    child.once('exit', handleExit)
  })

const stopChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      await execFileP('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        console.error(`[desktop] Could not terminate process tree ${child.pid}:`, error)
        child.kill('SIGKILL')
      }
    }
    if (!(await waitForChildExit(child, 5_000))) child.kill('SIGKILL')
    return
  }

  child.kill('SIGTERM')
  if (await waitForChildExit(child, 5_000)) return
  child.kill('SIGKILL')
  await waitForChildExit(child, 1_000)
}

const spawnNode = (nodeExecutable, args, environment, label, readyText) => {
  const child = spawn(nodeExecutable, args, {
    cwd: projectRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  pipeChildOutput(child, label)
  return { child, ready: waitForChildReady(child, label, readyText) }
}

const launchLocalServices = async ({ dataDir, randomPorts = false } = {}) => {
  const sourceRuntimeEntry = resolve(projectRoot, 'src', 'cli', 'hive.ts')
  const builtRuntimeEntry = resolve(projectRoot, 'dist', 'src', 'cli', 'hive.js')
  const viteEntry = resolve(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  const sourceCheckout = existsSync(sourceRuntimeEntry) && existsSync(viteEntry)
  const runtimeEntry = sourceCheckout ? sourceRuntimeEntry : builtRuntimeEntry
  if (!existsSync(runtimeEntry)) throw new Error('HiveTeam runtime entry was not found')

  const runtimePort =
    readRequestedPort('HIVE_RUNTIME_PORT') ??
    (randomPorts ? await findFreePort() : sourceCheckout ? 4010 : 9483)
  const webPort = readRequestedPort('HIVE_WEB_PORT') ?? (randomPorts ? await findFreePort() : 5180)
  if (runtimePort === webPort) throw new Error('Runtime and web ports must be different')

  const bridgeToken = randomBytes(32).toString('hex')
  const nodeExecutable =
    process.env.HIVE_NODE_EXECUTABLE?.trim() || process.env.npm_node_execpath?.trim() || 'node'
  const environment = createDesktopServiceEnvironment(process.env, {
    ...(dataDir ? { HIVE_DATA_DIR: dataDir } : {}),
    HIVE_DESKTOP_BRIDGE_TOKEN: bridgeToken,
    HIVE_RUNTIME_PORT: String(runtimePort),
    HIVE_WEB_PORT: String(webPort),
  })
  const runtimeProcess = spawnNode(
    nodeExecutable,
    sourceCheckout
      ? ['--import', 'tsx', runtimeEntry, '--port', String(runtimePort)]
      : [runtimeEntry, '--port', String(runtimePort)],
    environment,
    'runtime',
    `Hive running at http://127.0.0.1:${runtimePort}`
  )
  const webProcess = sourceCheckout
    ? spawnNode(
        nodeExecutable,
        [viteEntry, '--config', resolve(projectRoot, 'web', 'vite.config.ts')],
        environment,
        'web',
        `http://127.0.0.1:${webPort}`
      )
    : null
  const serviceProcesses = webProcess
    ? [
        { child: runtimeProcess.child, label: 'Runtime' },
        { child: webProcess.child, label: 'Web app' },
      ]
    : [{ child: runtimeProcess.child, label: 'Runtime' }]
  const children = serviceProcesses.map(({ child }) => child)
  const runtimeOrigin = `http://127.0.0.1:${runtimePort}`
  const appOrigin = sourceCheckout ? `http://127.0.0.1:${webPort}` : runtimeOrigin
  let stopping = false
  let unexpectedExit = null
  let unexpectedExitHandler = null
  let stopPromise = null
  const reportUnexpectedExit = (error) => {
    if (stopping || unexpectedExit) return
    unexpectedExit = error
    unexpectedExitHandler?.(error)
  }
  for (const { child, label } of serviceProcesses) {
    child.on('error', (error) => {
      reportUnexpectedExit(new Error(`${label} process failed`, { cause: error }))
    })
    child.on('exit', (code, signal) => {
      if (stopping) return
      const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
      reportUnexpectedExit(new Error(`${label} process exited unexpectedly with ${reason}`))
    })
  }
  const stop = () => {
    if (stopPromise) return stopPromise
    stopping = true
    stopPromise = Promise.allSettled(children.map(stopChild)).then(() => undefined)
    return stopPromise
  }

  try {
    await Promise.all([runtimeProcess.ready, ...(webProcess ? [webProcess.ready] : [])])
    await waitForHttp(`${runtimeOrigin}/api/version`, children)
    if (webProcess) await waitForHttp(`${appOrigin}/`, children)
  } catch (error) {
    await stop()
    throw error
  }

  return {
    appOrigin,
    bridgeToken,
    onUnexpectedExit: (handler) => {
      unexpectedExitHandler = handler
      if (unexpectedExit) queueMicrotask(() => handler(unexpectedExit))
    },
    runtimeOrigin,
    stop,
  }
}

const installDesktopBridge = ({ appOrigin, bridgeToken, runtimeOrigin, window }) => {
  ipcMain.removeHandler(PROBE_DROPPED_FOLDER_CHANNEL)
  ipcMain.handle(PROBE_DROPPED_FOLDER_CHANNEL, async (event, path) => {
    if (
      event.sender.id !== window.webContents.id ||
      !event.senderFrame.url.startsWith(`${appOrigin}/`) ||
      typeof path !== 'string'
    ) {
      return { error_code: 'path_unavailable', ok: false }
    }

    try {
      const response = await fetch(`${runtimeOrigin}/api/desktop/folders/probe`, {
        body: JSON.stringify({ path }),
        headers: {
          'content-type': 'application/json',
          'x-hive-desktop-token': bridgeToken,
        },
        method: 'POST',
        signal: AbortSignal.timeout(FOLDER_PROBE_TIMEOUT_MS),
      })
      if (!response.ok) return { error_code: 'runtime_unavailable', ok: false }
      const probe = await response.json()
      if (!probe?.ok || !probe.is_dir) {
        return {
          error_code: probe?.exists && !probe.is_dir ? 'not_directory' : 'path_unavailable',
          ok: false,
        }
      }
      return { ok: true, probe }
    } catch (error) {
      console.error('[desktop] Could not probe dropped folder:', error)
      return { error_code: 'runtime_unavailable', ok: false }
    }
  })
}

const createDesktopWindow = ({ appOrigin, show }) => {
  const window = new BrowserWindow({
    backgroundColor: '#090b0f',
    height: 900,
    minHeight: 640,
    minWidth: 960,
    show: false,
    title: 'HiveTeam',
    webPreferences: {
      contextIsolation: true,
      devTools: process.env.HIVE_DESKTOP_DEVTOOLS === '1',
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
    },
    width: 1440,
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${appOrigin}/`)) event.preventDefault()
  })
  if (show) window.once('ready-to-show', () => window.show())
  return window
}

export const launchHiveDesktop = async ({ dataDir, randomPorts = false, show = true } = {}) => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  const services = await launchLocalServices({ dataDir, randomPorts })
  let window = null

  try {
    window = createDesktopWindow({ appOrigin: services.appOrigin, show })
    services.onUnexpectedExit((error) => {
      console.error('[desktop] Local service stopped unexpectedly:', error)
      void services.stop().finally(() => {
        if (window && !window.isDestroyed()) window.destroy()
      })
    })
    installDesktopBridge({ ...services, window })
    await window.loadURL(`${services.appOrigin}/`)
  } catch (error) {
    ipcMain.removeHandler(PROBE_DROPPED_FOLDER_CHANNEL)
    if (window && !window.isDestroyed()) window.destroy()
    await services.stop()
    throw error
  }

  let closed = false
  return {
    appOrigin: services.appOrigin,
    runtimeOrigin: services.runtimeOrigin,
    window,
    close: async () => {
      if (closed) return
      closed = true
      ipcMain.removeHandler(PROBE_DROPPED_FOLDER_CHANNEL)
      if (!window.isDestroyed()) window.destroy()
      await services.stop()
    },
  }
}
