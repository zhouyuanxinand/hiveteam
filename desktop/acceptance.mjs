import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { app } from 'electron'

import { launchHiveDesktop } from './app.mjs'

const requestedFolder = process.argv[2]
const resultPath = process.env.HIVE_DESKTOP_ACCEPTANCE_RESULT_PATH
const screenshotDir = process.env.HIVE_DESKTOP_ACCEPTANCE_SCREENSHOT_DIR
if (!resultPath) throw new Error('HIVE_DESKTOP_ACCEPTANCE_RESULT_PATH is required')
const acceptanceRoot = mkdtempSync(join(tmpdir(), 'hiveteam-desktop-acceptance-'))
const writeResult = (ok, error) => {
  writeFileSync(resultPath, JSON.stringify({ cleanup_path: acceptanceRoot, error, ok }))
}
const folderPath = requestedFolder
  ? resolve(requestedFolder)
  : join(acceptanceRoot, '中文 folder with spaces')
if (!requestedFolder) mkdirSync(folderPath, { recursive: true })
if (!existsSync(folderPath)) throw new Error(`Acceptance folder does not exist: ${folderPath}`)

const userDataPath = join(acceptanceRoot, 'electron-user-data')
mkdirSync(userDataPath, { recursive: true })
app.disableHardwareAcceleration()
app.setPath('userData', userDataPath)
app.on('window-all-closed', () => {})
console.log(`[desktop acceptance] waiting for Electron; folder: ${folderPath}`)

const waitForRendererValue = async (webContents, expression, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await webContents.executeJavaScript(expression)
    if (value !== null && value !== false) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  return null
}

const capture = async (webContents, name) => {
  if (!screenshotDir) return
  mkdirSync(screenshotDir, { recursive: true })
  const image = await webContents.capturePage()
  writeFileSync(join(screenshotDir, name), image.toPNG())
}

const waitForCommittedPaint = async (webContents) => {
  await webContents.executeJavaScript(`new Promise((resolvePaint) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolvePaint(true)))
  })`)
}

const runAcceptance = async () => {
  console.log('[desktop acceptance] Electron ready; starting HiveTeam services')
  let desktop
  let failureMessage = null
  try {
    desktop = await launchHiveDesktop({
      dataDir: join(acceptanceRoot, 'hive-data'),
      randomPorts: true,
      show: Boolean(screenshotDir),
    })
    console.log(`[desktop acceptance] app loaded from ${desktop.appOrigin}`)
    const webContents = desktop.window.webContents
    await webContents.executeJavaScript('document.readyState')
    await waitForRendererValue(
      webContents,
      "Boolean(document.querySelector('[role=dialog]'))",
      5_000
    )
    webContents.debugger.attach('1.3')
    const dragData = {
      dragOperationsMask: 1,
      files: [folderPath],
      items: [{ data: basename(folderPath), mimeType: 'text/plain' }],
    }
    await webContents.debugger.sendCommand('Input.dispatchDragEvent', {
      data: dragData,
      type: 'dragEnter',
      x: 720,
      y: 450,
    })
    await waitForRendererValue(
      webContents,
      "Boolean(document.querySelector('[data-testid=desktop-folder-drop-overlay][data-state=ready]'))"
    )
    await waitForCommittedPaint(webContents)
    await capture(webContents, 'drag-ready-1440x900.png')
    desktop.window.setBounds({ height: 640, width: 960 })
    await waitForCommittedPaint(webContents)
    await capture(webContents, 'drag-ready-960x640.png')

    for (const type of ['dragOver', 'drop']) {
      await webContents.debugger.sendCommand('Input.dispatchDragEvent', {
        data: dragData,
        type,
        x: 480,
        y: 320,
      })
    }
    const resolvingVisible = await waitForRendererValue(
      webContents,
      "Boolean(document.querySelector('[data-testid=desktop-folder-drop-overlay][data-state=resolving]'))",
      250
    )
    if (resolvingVisible) {
      await waitForCommittedPaint(webContents)
      await capture(webContents, 'drag-resolving-960x640.png')
    }

    const selectedPath = await waitForRendererValue(
      webContents,
      "document.querySelector('[data-testid=confirm-workspace-path]')?.value ?? null"
    )
    if (selectedPath !== folderPath) {
      throw new Error(`Expected dropped path ${folderPath}, received ${selectedPath ?? 'no value'}`)
    }
    const confirmSettled = await waitForRendererValue(
      webContents,
      `(() => {
        const dialog = document.querySelector('[data-testid=confirm-workspace-dialog]')
        if (!dialog) return false
        const style = getComputedStyle(dialog)
        return style.visibility !== 'hidden' && Number(style.opacity) >= 0.99 &&
          dialog.getAnimations().every((animation) => animation.playState === 'finished')
      })()`,
      2_000
    )
    if (!confirmSettled) {
      throw new Error('Workspace confirmation dialog did not finish opening')
    }
    await waitForCommittedPaint(webContents)
    await capture(webContents, 'confirm-960x640.png')
    console.log(`[desktop acceptance] exact folder path confirmed: ${selectedPath}`)
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error)
    console.error('[desktop acceptance] failed:', error)
  } finally {
    if (desktop?.window.webContents.debugger.isAttached()) {
      desktop.window.webContents.debugger.detach()
    }
    await desktop?.close()
    writeResult(failureMessage === null, failureMessage)
    app.quit()
  }
}

void app
  .whenReady()
  .then(runAcceptance)
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[desktop acceptance] could not start:', error)
    writeResult(false, message)
    app.quit()
  })
