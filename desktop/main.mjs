import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, dialog, Menu, nativeImage, shell, Tray } from 'electron'

import { launchHiveDesktop, launchHiveWebHost } from './app.mjs'
import {
  bindDesktopCloseConfirmation,
  chooseLaunchMode,
  createDesktopCloseDialogOptions,
  getDesktopLaunchCopy,
} from './launch-mode.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const trayIconPath = resolve(projectRoot, 'assets', 'logo.png')

let desktop = null
let webHost = null
let tray = null
let stopping = false

const getLocale = () => app.getLocale() || 'en'
const getActiveHost = () => desktop ?? webHost

const stopAndQuit = async () => {
  if (stopping) return
  stopping = true

  const activeHost = getActiveHost()
  await activeHost?.close()

  desktop = null
  webHost = null
  tray?.destroy()
  tray = null
  app.quit()
}

const showError = (message, error) => {
  const detail = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox('HiveTeam', `${message}\n\n${detail}`)
}

const openWebInterface = async () => {
  if (!webHost) return
  try {
    await shell.openExternal(webHost.appOrigin)
  } catch (error) {
    showError(getDesktopLaunchCopy(getLocale()).webOpenError, error)
  }
}

const createWebModeTray = () => {
  const copy = getDesktopLaunchCopy(getLocale())
  const size = process.platform === 'darwin' ? 18 : 16
  const icon = nativeImage.createFromPath(trayIconPath).resize({ height: size, width: size })
  if (icon.isEmpty()) throw new Error(`HiveTeam tray icon was not found: ${trayIconPath}`)

  const nextTray = new Tray(icon)
  nextTray.setToolTip(copy.trayTooltip)
  nextTray.setContextMenu(
    Menu.buildFromTemplate([
      { click: () => void openWebInterface(), label: copy.trayOpen },
      { type: 'separator' },
      { click: () => void stopAndQuit(), label: copy.trayQuit },
    ])
  )
  nextTray.on('double-click', () => void openWebInterface())
  return nextTray
}

const startDesktopMode = async () => {
  desktop = await launchHiveDesktop({ show: false })
  bindDesktopCloseConfirmation({
    window: desktop.window,
    confirm: async () => {
      if (!desktop || desktop.window.isDestroyed()) return true
      const result = await dialog.showMessageBox(
        desktop.window,
        createDesktopCloseDialogOptions(getLocale())
      )
      return result.response === 1
    },
    close: stopAndQuit,
    onError: (error) => showError(getDesktopLaunchCopy(getLocale()).closeError, error),
  })
  desktop.window.show()
}

const startWebMode = async () => {
  webHost = await launchHiveWebHost()
  webHost.onUnexpectedExit((error) => {
    showError(getDesktopLaunchCopy(getLocale()).webServiceError, error)
    void stopAndQuit()
  })
  tray = createWebModeTray()
  await shell.openExternal(webHost.appOrigin)
}

const focusCurrentInterface = () => {
  if (desktop && !desktop.window.isDestroyed()) {
    if (desktop.window.isMinimized()) desktop.window.restore()
    desktop.window.show()
    desktop.window.focus()
    return
  }
  void openWebInterface()
}

const start = async () => {
  const mode = await chooseLaunchMode({
    configuredMode: process.env.HIVE_DESKTOP_LAUNCH_MODE,
    locale: getLocale(),
    showMessageBox: (options) => dialog.showMessageBox(options),
  })
  if (!mode) {
    app.quit()
    return
  }

  if (mode === 'desktop') await startDesktopMode()
  else await startWebMode()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', focusCurrentInterface)
  app.on('activate', focusCurrentInterface)
  app.on('before-quit', (event) => {
    if (!getActiveHost() || stopping) return
    event.preventDefault()
    void stopAndQuit()
  })
  app.on('window-all-closed', () => void stopAndQuit())
  process.once('SIGINT', () => void stopAndQuit())
  process.once('SIGTERM', () => void stopAndQuit())

  void app
    .whenReady()
    .then(start)
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox('HiveTeam could not start', message)
      await stopAndQuit()
    })
}
