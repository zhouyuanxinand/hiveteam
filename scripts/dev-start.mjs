import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createUiLaunchUrl, openUiBrowser, requestUiBootstrap } from './ui-launcher.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRuntimeEntry = resolve(projectRoot, 'src', 'cli', 'hive.ts')
const builtRuntimeEntry = resolve(projectRoot, 'dist', 'src', 'cli', 'hive.js')
const viteEntry = resolve(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const isSourceCheckout = existsSync(sourceRuntimeEntry) && existsSync(viteEntry)

const readPort = (name, fallback) => {
  const rawValue = process.env[name]?.trim()
  if (!rawValue) return fallback

  const port = Number(rawValue)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`)
  }
  return port
}

const runtimePort = readPort('HIVE_RUNTIME_PORT', isSourceCheckout ? 4010 : 9483)
const webPort = readPort('HIVE_WEB_PORT', 5180)
const childEnvironment = {
  ...process.env,
  HIVE_DATA_DIR: resolve(process.env.HIVE_DATA_DIR || join(homedir(), '.config', 'hive')),
  HIVE_RUNTIME_PORT: String(runtimePort),
  HIVE_WEB_PORT: String(webPort),
}

const spawnNode = (args, ipc = false) =>
  spawn(process.execPath, args, {
    cwd: projectRoot,
    env: childEnvironment,
    stdio: ipc ? ['inherit', 'pipe', 'inherit', 'ipc'] : 'inherit',
    windowsHide: true,
  })

console.log(`[HiveTeam] Runtime: http://127.0.0.1:${runtimePort}`)
console.log(`[HiveTeam] Data directory: ${childEnvironment.HIVE_DATA_DIR}`)
if (isSourceCheckout) console.log(`[HiveTeam] Web:     http://127.0.0.1:${webPort}`)

const runtime = spawnNode(
  isSourceCheckout
    ? ['--import', 'tsx', sourceRuntimeEntry, '--port', String(runtimePort)]
    : [builtRuntimeEntry, '--port', String(runtimePort)],
  true
)
runtime.stdout.on('data', (chunk) => process.stdout.write(chunk))
const web = isSourceCheckout
  ? spawnNode([viteEntry, '--config', resolve(projectRoot, 'web', 'vite.config.ts')])
  : null
const children = web ? [runtime, web] : [runtime]
let shuttingDown = false

const stopChild = (child) =>
  new Promise((resolveStop) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveStop()
      return
    }

    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5_000)

    child.once('exit', () => {
      clearTimeout(forceKill)
      resolveStop()
    })
    child.kill('SIGTERM')
  })

const shutdown = async (exitCode) => {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.allSettled(children.map(stopChild))
  process.stdin.pause()
  if (process.connected) process.disconnect()
  process.exitCode = exitCode
}

const handleUnexpectedExit = (name, code, signal) => {
  if (shuttingDown) return
  const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
  console.error(`[HiveTeam] ${name} exited with ${reason}`)
  void shutdown(code === 0 ? 0 : 1)
}

runtime.once('error', (error) => {
  console.error('[HiveTeam] Could not start the runtime:', error.message)
  void shutdown(1)
})
web?.once('error', (error) => {
  console.error('[HiveTeam] Could not start the web app:', error.message)
  void shutdown(1)
})
runtime.once('exit', (code, signal) => handleUnexpectedExit('Runtime', code, signal))
web?.once('exit', (code, signal) => handleUnexpectedExit('Web app', code, signal))

process.once('SIGINT', () => void shutdown(0))
process.once('SIGTERM', () => void shutdown(0))

const appOrigin = `http://127.0.0.1:${isSourceCheckout ? webPort : runtimePort}`
const openInterface = async () => openUiBrowser(await createUiLaunchUrl(runtime, appOrigin))
const launchInterface = async () => {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline && !shuttingDown) {
    let ready = false
    try {
      const responses = await Promise.all([
        fetch(`http://127.0.0.1:${runtimePort}/api/version`, { signal: AbortSignal.timeout(1000) }),
        fetch(appOrigin, { signal: AbortSignal.timeout(1000) }),
      ])
      ready = responses.every((response) => response.ok)
    } catch {
      // The bounded startup loop retries while the two child services bind.
    }
    if (ready) {
      await openInterface()
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  if (!shuttingDown) throw new Error('Hive did not become ready before the startup deadline')
}
if (process.send) {
  process.on('message', (message) => {
    if (
      message?.type !== 'hive:create-ui-bootstrap' ||
      typeof message.request_id !== 'string' ||
      message.request_id.length > 128
    )
      return
    void requestUiBootstrap(runtime)
      .then((token) =>
        process.send?.({
          type: 'hive:ui-bootstrap',
          request_id: message.request_id,
          bootstrap_token: token,
        })
      )
      .catch((error) => console.error(`[HiveTeam] ${error.message}`))
  })
} else {
  void launchInterface().catch((error) => console.error(`[HiveTeam] ${error.message}`))
}
if (!process.send && process.stdin.isTTY) {
  console.log('[HiveTeam] Enter o to reopen an authenticated browser window.')
  process.stdin.on('data', (input) => {
    if (input.toString().trim().toLowerCase() !== 'o') return
    void openInterface().catch((error) => console.error(`[HiveTeam] ${error.message}`))
  })
}
