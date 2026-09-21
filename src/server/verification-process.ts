import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { ExecutionCancelledError, type ManagedExecution } from './managed-execution.js'
import { recheckRemoteAction } from './remote-action-context.js'
import { ResourceReservationError } from './resource-budget-store.js'

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 15 * 60 * 1000

/** Runs an explicitly requested foreground command, including its process tree. */
export const runVerificationCommand = (input: {
  cwd: string
  command: string
  signal: AbortSignal
  execution: ManagedExecution
  runId: string
  onOutput: (text: string) => void
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  launcher?: string | null
}): Promise<number | null> =>
  new Promise((resolve, reject) => {
    if (!input.execution)
      throw new ResourceReservationError(
        'A resource reservation is required to spawn a verification.'
      )
    try {
      if (input.signal.aborted) throw new ExecutionCancelledError()
      input.execution.assertReserved()
      recheckRemoteAction()
    } catch (error) {
      input.execution.cancelBeforeSpawn()
      throw error
    }
    const windows = process.platform === 'win32'
    const env =
      input.env ??
      Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HIVE_')))
    input.execution.beginSpawn()
    let child: ReturnType<typeof spawn>
    try {
      const shell = windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
      const args = windows ? ['/d', '/s', '/c', `"${input.command}"`] : ['-c', input.command]
      child = spawn(
        input.launcher ?? shell,
        input.launcher ? ['sandbox', '--', shell, ...args] : args,
        {
          cwd: input.cwd,
          env,
          windowsHide: true,
          windowsVerbatimArguments: windows,
          detached: !windows,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
    } catch (error) {
      input.execution.spawnFailed()
      throw error
    }
    let failure: Error | null = null
    let terminating: Promise<void> | null = null
    const terminate = () => {
      if (terminating || !child.pid) return
      const pid = child.pid
      terminating = (async () => {
        if (windows) {
          try {
            await execFileAsync('taskkill', ['/pid', String(pid), '/t', '/f'], {
              windowsHide: true,
              timeout: 10_000,
            })
          } catch (error) {
            // The command can finish while taskkill is starting.
            if (child.exitCode === null && child.signalCode === null) throw error
          }
        } else {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
      })()
      void terminating.catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error))
        child.kill('SIGKILL')
      })
    }
    const output = (text: string) => {
      try {
        input.onOutput(text)
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        terminate()
      }
    }
    child.stdout?.setEncoding('utf8').on('data', output)
    child.stderr?.setEncoding('utf8').on('data', output)
    child.once('spawn', () => {
      try {
        input.execution.markStarted({
          runId: input.runId,
          pid: child.pid ?? null,
          startedAt: Date.now(),
        })
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        terminate()
      }
    })
    child.once('error', (error) => {
      failure = error
    })
    const timer = setTimeout(() => {
      failure = new Error(`Verification exceeded its ${input.timeoutMs ?? TIMEOUT_MS} ms timeout.`)
      terminate()
    }, input.timeoutMs ?? TIMEOUT_MS)
    input.signal.addEventListener('abort', terminate, { once: true })
    if (input.signal.aborted) terminate()
    child.once('close', (code) => {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', terminate)
      const finish = () => {
        try {
          if (child.pid) input.execution.confirmExit(input.runId, child.pid)
          else input.execution.spawnFailed()
        } catch (error) {
          reject(error)
          return
        }
        if (failure) reject(failure)
        else resolve(code)
      }
      if (terminating)
        void terminating.then(finish, (error: unknown) => {
          input.execution.markUnconfirmed(
            'Verification process tree termination could not be confirmed.'
          )
          reject(error)
        })
      else finish()
    })
  })
