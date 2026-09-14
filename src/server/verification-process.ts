import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 15 * 60 * 1000

/** Runs an explicitly requested foreground command, including its process tree. */
export const runVerificationCommand = (input: {
  cwd: string
  command: string
  signal: AbortSignal
  onOutput: (text: string) => void
}): Promise<number | null> =>
  new Promise((resolve, reject) => {
    const windows = process.platform === 'win32'
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('HIVE_'))
    )
    const child = spawn(
      windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
      windows ? ['/d', '/s', '/c', input.command] : ['-c', input.command],
      {
        cwd: input.cwd,
        env,
        windowsHide: true,
        detached: !windows,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
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
    child.stdout.setEncoding('utf8').on('data', output)
    child.stderr.setEncoding('utf8').on('data', output)
    child.once('error', (error) => {
      failure = error
    })
    const timer = setTimeout(() => {
      failure = new Error('Verification exceeded the 15 minute limit.')
      terminate()
    }, TIMEOUT_MS)
    input.signal.addEventListener('abort', terminate, { once: true })
    if (input.signal.aborted) terminate()
    child.once('close', (code) => {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', terminate)
      const finish = () => (failure ? reject(failure) : resolve(code))
      if (terminating) void terminating.then(finish, finish)
      else finish()
    })
  })
