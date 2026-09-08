import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  HIVE_RUNTIME_PORT: String(runtimePort),
  HIVE_WEB_PORT: String(webPort),
}

const spawnNode = (args) =>
  spawn(process.execPath, args, {
    cwd: projectRoot,
    env: childEnvironment,
    stdio: 'inherit',
  })

console.log(`[HiveTeam] Runtime: http://127.0.0.1:${runtimePort}`)
if (isSourceCheckout) console.log(`[HiveTeam] Web:     http://127.0.0.1:${webPort}`)

const runtime = spawnNode(
  isSourceCheckout
    ? ['--import', 'tsx', sourceRuntimeEntry, '--port', String(runtimePort)]
    : [builtRuntimeEntry, '--port', String(runtimePort)]
)
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
