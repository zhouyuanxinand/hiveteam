import { execFile, spawn } from 'node:child_process'
import { delimiter, dirname } from 'node:path'
import { promisify } from 'node:util'
import { requestUiBootstrap } from './ui-launcher.mjs'

const runFile = promisify(execFile)

export const activeNodeEnvironment = (overrides = {}) => ({
  ...process.env,
  ...overrides,
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
})

export const captureChild = (file, args, options) => {
  const child = spawn(file, args, { windowsHide: true, ...options })
  const output = { stdout: '', stderr: '' }
  child.stdout?.on('data', (chunk) => {
    output.stdout = (output.stdout + chunk).slice(-64_000)
  })
  child.stderr?.on('data', (chunk) => {
    output.stderr = (output.stderr + chunk).slice(-64_000)
  })
  let result
  const closed = new Promise((resolve) => {
    child.once('error', (error) => {
      result = { error }
    })
    child.once('close', (code, signal) => {
      result = { ...result, code, signal }
      resolve(result)
    })
  })
  return { child, closed, output, getResult: () => result }
}

export const stopOwnedChild = async (processHandle) => {
  const { child, closed, getResult } = processHandle
  if (getResult() || child.exitCode !== null || child.signalCode !== null) {
    return { ...(await closed), forced: false }
  }
  if (process.platform === 'win32') {
    let forced = false
    try {
      await runFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
      })
      forced = true
    } catch (error) {
      if (!getResult()) throw error
    }
    return { ...(await closed), forced }
  }
  child.kill('SIGTERM')
  let timer
  const exited = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5000)
    }),
  ])
  clearTimeout(timer)
  if (!exited) {
    child.kill('SIGKILL')
    await closed
    throw new Error('Packaged runtime did not stop after SIGTERM')
  }
  return { ...(await closed), forced: false }
}

// Platform guardians own child services. Let them flush state and close those
// children before using the generic termination path for an unresponsive process.
export const stopPlatformChild = async (processHandle, { shutdownTimeoutMs = 10_000 } = {}) => {
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0)
    throw new Error('Platform shutdown timeout must be positive')
  const { child, closed, getResult } = processHandle
  if (getResult() || child.exitCode !== null || child.signalCode !== null)
    return { ...(await closed), forced: false }
  if (child.connected) {
    let timer
    const exited = await new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), shutdownTimeoutMs)
      closed.then(() => resolve(true))
      child.send({ type: 'hive:shutdown' }, (error) => {
        if (error) resolve(false)
      })
    })
    clearTimeout(timer)
    if (exited) return { ...(await closed), forced: false }
  }
  return stopOwnedChild(processHandle)
}

export const stopInstalledRuntime = async (processHandle, options) => {
  const result = await stopPlatformChild(processHandle, options)
  if (result.error) throw result.error
  if (!result.forced && result.code !== 0) {
    throw new Error(
      `Packaged runtime exited with ${result.signal ?? `code ${result.code}`}\n${processHandle.output.stderr}`
    )
  }
  return result
}

export const waitForRuntime = async (predicate, description, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

export const startInstalledRuntime = async ({ entry, cwd, dataDir }) => {
  const env = activeNodeEnvironment({ HIVE_DATA_DIR: dataDir })
  // The package acceptance runs the production PTY backend, including ConPTY.
  const processHandle = captureChild(process.execPath, [entry, '--port', '0'], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const { child, output, getResult } = processHandle
  let stopping
  const stop = () => {
    stopping ??= stopInstalledRuntime(processHandle).finally(() => {
      if (output.stderr) process.stderr.write(output.stderr)
    })
    return stopping
  }
  try {
    const port = await waitForRuntime(
      () => {
        const result = getResult()
        if (result)
          throw result.error ?? new Error(`Runtime exited: ${result.code ?? result.signal}`)
        return output.stdout.match(/Hive running at http:\/\/127\.0\.0\.1:(\d+)/)?.[1]
      },
      'installed runtime startup',
      60_000
    )
    const baseUrl = `http://127.0.0.1:${port}`
    const bootstrap = () => requestUiBootstrap(child)
    const response = await fetch(`${baseUrl}/api/ui/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: await bootstrap() }),
    })
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    if (!response.ok || !cookie) throw new Error(`UI session returned ${response.status}`)
    return { baseUrl, cookie, bootstrap, stop }
  } catch (error) {
    try {
      await stop()
    } catch (stopError) {
      throw new AggregateError(
        [error, stopError],
        `Installed runtime startup failed: ${error.message}; cleanup failed: ${stopError.message}\n${output.stdout}\n${output.stderr}`
      )
    }
    throw new Error(`${error.message}\n${output.stdout}\n${output.stderr}`, { cause: error })
  }
}
