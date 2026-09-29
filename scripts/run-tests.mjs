import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const temporaryParent = resolve(tmpdir())
const root = await mkdtemp(join(temporaryParent, 'hive-tests-'))
const temporary = join(root, 'tmp')
const dataDir = join(root, 'data')
let child
let interrupted = null
let termination

const forwardSignal = (signal) => {
  if (!child?.pid || interrupted) return
  interrupted = signal
  if (process.platform === 'win32') {
    // Windows has no POSIX process groups. Terminate only this test child's tree.
    termination = new Promise((resolveTermination, reject) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', reject)
      killer.once('close', resolveTermination)
    })
  } else {
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
}

const onInterrupt = () => forwardSignal('SIGINT')
const onTerminate = () => forwardSignal('SIGTERM')

try {
  await Promise.all([mkdir(temporary), mkdir(dataDir)])
  const args = process.argv.slice(2)
  child = spawn(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), ...args], {
    cwd: repository,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      HIVE_DATA_DIR: dataDir,
      HIVE_TEST_RUN_ROOT: root,
      // Apply before Vitest loads anything; both temporary workspaces and the
      // default data directory must stop before any developer ancestor repo.
      GIT_CEILING_DIRECTORIES: [root, temporary, process.env.GIT_CEILING_DIRECTORIES]
        .filter(Boolean)
        .join(delimiter),
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
    },
    stdio: 'inherit',
    windowsHide: true,
  })
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  const result = await new Promise((resolveResult, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolveResult({ code, signal }))
  })
  await termination
  const signal = interrupted ?? result.signal
  process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : (result.code ?? 1)
} catch (error) {
  console.error('[hive test runner]', error)
  process.exitCode = 1
} finally {
  process.off('SIGINT', onInterrupt)
  process.off('SIGTERM', onTerminate)
  // Never clean the inherited HIVE_DATA_DIR or a caller-supplied directory.
  if (dirname(resolve(root)) !== temporaryParent || !basename(root).startsWith('hive-tests-')) {
    console.error(`[hive test runner] Refusing to remove an unexpected test directory: ${root}`)
    process.exitCode = 1
  } else {
    try {
      // Vitest has closed its workers before its close event. Windows can take a
      // moment to release directory handles, so retry cleanup without hiding failure.
      await rm(root, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
    } catch (error) {
      console.error(`[hive test runner] Could not remove ${root}`, error)
      process.exitCode = process.exitCode || 1
    }
  }
}
