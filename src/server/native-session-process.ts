import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { resolveSpawnCommand } from './agent-command-resolver.js'
import { createExecutionEnvironment } from './execution-environment.js'
import { ExecutionCancelledError, type ManagedExecution } from './managed-execution.js'
import { withoutManagementCredentials } from './management-environment.js'
import { NativeSessionError } from './native-session-error.js'
import { recheckRemoteAction } from './remote-action-context.js'

const execFileAsync = promisify(execFile)

/** One foreground preparation process, inside the future PTY's reserved slot. No prompt/model calls. */
export const runNativeSessionProcess = async (input: {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  execution: ManagedExecution
  assertPolicy: () => Promise<void>
  timeoutMs?: number
  exchange?: {
    initial: unknown
    receive: (message: unknown, send: (value: unknown) => void) => boolean
  }
}) => {
  await input.assertPolicy()
  input.execution.assertReserved()
  recheckRemoteAction()
  const env = withoutManagementCredentials(createExecutionEnvironment(input.env))
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('HIVE_')) delete env[key]
  const resolved = resolveSpawnCommand(input.command, input.cwd, env, input.args)
  const runId = randomUUID()
  input.execution.beginSpawn()
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
    (resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(
          resolved.command,
          typeof resolved.args === 'string' ? [resolved.args] : resolved.args,
          {
            cwd: input.cwd,
            env,
            windowsHide: true,
            windowsVerbatimArguments: typeof resolved.args === 'string',
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        )
      } catch (error) {
        input.execution.finishPreparation(runId, null)
        reject(error)
        return
      }
      let stdout = '',
        stderr = '',
        lines = '',
        received = false
      let failure: unknown, terminating: Promise<void> | undefined
      const terminate = () => {
        if (terminating || !child.pid) return
        const pid = child.pid
        terminating = (async () => {
          if (process.platform === 'win32') {
            try {
              await execFileAsync('taskkill', ['/pid', String(pid), '/t', '/f'], {
                windowsHide: true,
                timeout: 10000,
              })
            } catch (error) {
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
          failure = error
          child.kill('SIGKILL')
        })
      }
      const send = (value: unknown) => child.stdin?.write(`${JSON.stringify(value)}\n`)
      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE' || !received) {
          failure = error
          terminate()
        }
      })
      child.once('spawn', () => {
        try {
          input.execution.markStarted({ runId, pid: child.pid ?? null, startedAt: Date.now() })
          if (input.exchange) send(input.exchange.initial)
          else child.stdin?.end()
        } catch (error) {
          failure = error
          terminate()
        }
      })
      const accept = (chunk: string, stream: 'stdout' | 'stderr') => {
        if (stream === 'stdout' && !input.exchange) stdout += chunk
        else if (stream === 'stderr') stderr += chunk
        if (stdout.length + stderr.length > 262144) {
          failure = new NativeSessionError(
            'session_native_failure',
            'Native session diagnostics exceeded the output limit.'
          )
          terminate()
          return
        }
        if (!input.exchange || stream !== 'stdout' || received) return
        lines += chunk
        if (lines.length > 1048576) {
          failure = new NativeSessionError(
            'session_native_failure',
            'An ACP protocol frame exceeded the supported size.'
          )
          terminate()
          return
        }
        let index = lines.indexOf('\n')
        while (index >= 0 && !received) {
          const line = lines.slice(0, index).trim()
          lines = lines.slice(index + 1)
          try {
            if (line && input.exchange.receive(JSON.parse(line), send)) {
              received = true
              terminate()
            }
          } catch (error) {
            failure = error
            terminate()
            return
          }
          index = lines.indexOf('\n')
        }
      }
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => accept(chunk, 'stdout'))
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => accept(chunk, 'stderr'))
      child.once('error', (error) => {
        failure = error
      })
      const cancel = () => {
        failure = new ExecutionCancelledError()
        terminate()
      }
      input.execution.signal?.addEventListener('abort', cancel, { once: true })
      if (input.execution.signal?.aborted) cancel()
      const timer = setTimeout(() => {
        failure = new NativeSessionError(
          'session_native_failure',
          'Native session preparation timed out. Its result must not be retried blindly.'
        )
        terminate()
      }, input.timeoutMs ?? 15000)
      child.once('close', (exitCode) => {
        clearTimeout(timer)
        input.execution.signal?.removeEventListener('abort', cancel)
        void (async () => {
          try {
            await terminating
            input.execution.finishPreparation(runId, child.pid ?? null)
          } catch (error) {
            input.execution.markUnconfirmed(
              'Native session preparation exit could not be confirmed.'
            )
            throw error
          }
          if (failure) throw failure
          if (input.exchange && !received)
            throw new NativeSessionError(
              'session_native_failure',
              'Native session protocol closed before answering the identity check.'
            )
          return { stdout, stderr, exitCode }
        })().then(resolve, reject)
      })
    }
  )
}
