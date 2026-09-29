import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BrowserWindow, ipcMain, session } from 'electron'

import { launchPlatform } from '../scripts/platform-launch.mjs'

import { createDesktopServiceEnvironment } from './service-environment.mjs'

const PROBE_DROPPED_FOLDER_CHANNEL = 'hive-desktop:probe-dropped-folder'
const FOLDER_PROBE_TIMEOUT_MS = 10_000
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

const launchLocalServices = async ({ dataDir, randomPorts = false } = {}) => {
  const environment = createDesktopServiceEnvironment(
    process.env,
    dataDir ? { HIVE_DATA_DIR: dataDir } : {}
  )
  console.log(`[HiveTeam] Data directory: ${environment.HIVE_DATA_DIR}`)
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
  Object.assign(environment, {
    HIVE_DESKTOP_BRIDGE_TOKEN: bridgeToken,
    HIVE_RUNTIME_PORT: String(runtimePort),
    HIVE_WEB_PORT: String(webPort),
  })
  const platform = await launchPlatform({
    projectRoot,
    runtimeEntry,
    nodeExecutable,
    dataDir: environment.HIVE_DATA_DIR,
    runtimePort,
    webPort,
    launchMode: sourceCheckout ? 'development' : 'runtime',
    environment,
  })
  return {
    get appOrigin() {
      return platform.appOrigin
    },
    bridgeToken,
    createLaunchUrl: platform.createLaunchUrl,
    onRecovered: (handler) => platform.supervisor.onReady(handler),
    onUnexpectedExit: (handler) => {
      const notify = (status) =>
        handler(new Error(status.last_error || 'Platform recovery stopped'))
      const unsubscribe = platform.supervisor.onFailed(notify)
      const current = platform.supervisor.getStatus()
      if (current.state === 'failed') queueMicrotask(() => notify(current))
      return unsubscribe
    },
    get runtimeOrigin() {
      return platform.runtimeOrigin
    },
    stop: platform.stop,
  }
}

const installDesktopBridge = ({ services, window }) => {
  ipcMain.removeHandler(PROBE_DROPPED_FOLDER_CHANNEL)
  ipcMain.handle(PROBE_DROPPED_FOLDER_CHANNEL, async (event, path) => {
    if (
      event.sender.id !== window.webContents.id ||
      !event.senderFrame.url.startsWith(`${services.appOrigin}/`) ||
      typeof path !== 'string'
    ) {
      return { error_code: 'path_unavailable', ok: false }
    }

    try {
      const response = await fetch(`${services.runtimeOrigin}/api/desktop/folders/probe`, {
        body: JSON.stringify({ path }),
        headers: {
          'content-type': 'application/json',
          'x-hive-desktop-token': services.bridgeToken,
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

const createDesktopWindow = ({ services, show }) => {
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
    if (!url.startsWith(`${services.appOrigin}/`)) event.preventDefault()
  })
  if (show) window.once('ready-to-show', () => window.show())
  return window
}

export const launchHiveWebHost = async ({ dataDir, randomPorts = false } = {}) => {
  const services = await launchLocalServices({ dataDir, randomPorts })
  let closed = false

  return {
    get appOrigin() {
      return services.appOrigin
    },
    createLaunchUrl: services.createLaunchUrl,
    get runtimeOrigin() {
      return services.runtimeOrigin
    },
    onUnexpectedExit: services.onUnexpectedExit,
    onRecovered: services.onRecovered,
    close: async () => {
      if (closed) return
      closed = true
      await services.stop()
    },
  }
}

export const launchHiveDesktop = async ({ dataDir, randomPorts = false, show = true } = {}) => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  const services = await launchLocalServices({ dataDir, randomPorts })
  let window = null
  let closed = false
  let unsubscribeRecovery = () => {}

  try {
    window = createDesktopWindow({ services, show })
    services.onUnexpectedExit((error) => {
      console.error('[desktop] Local service stopped unexpectedly:', error)
      void services.stop().finally(() => {
        if (window && !window.isDestroyed()) window.destroy()
      })
    })
    installDesktopBridge({ services, window })
    unsubscribeRecovery = services.onRecovered(() => {
      if (closed || window.isDestroyed()) return
      void services
        .createLaunchUrl()
        .then((url) => {
          if (!closed && !window.isDestroyed()) return window.loadURL(url)
        })
        .catch((error) =>
          console.error('[desktop] Could not reload the recovered interface:', error)
        )
    })
    await window.loadURL(await services.createLaunchUrl())
  } catch (error) {
    unsubscribeRecovery()
    ipcMain.removeHandler(PROBE_DROPPED_FOLDER_CHANNEL)
    if (window && !window.isDestroyed()) window.destroy()
    await services.stop()
    throw error
  }

  return {
    get appOrigin() {
      return services.appOrigin
    },
    get runtimeOrigin() {
      return services.runtimeOrigin
    },
    window,
    createLaunchUrl: services.createLaunchUrl,
    close: async () => {
      if (closed) return
      closed = true
      unsubscribeRecovery()
      ipcMain.removeHandler(PROBE_DROPPED_FOLDER_CHANNEL)
      if (!window.isDestroyed()) window.destroy()
      await services.stop()
    },
  }
}
