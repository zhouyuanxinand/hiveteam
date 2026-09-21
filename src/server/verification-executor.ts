import type { DispatchVerification } from '../shared/verification.js'
import type { ManagedExecution } from './managed-execution.js'
import { prepareVerificationEnvironment } from './verification-environment.js'
import { createVerificationLogRedactor } from './verification-log-redactor.js'
import { type createVerificationLogs, redactVerificationLog } from './verification-logs.js'
import { runVerificationCommand } from './verification-process.js'
import { legacyVerificationProfile } from './verification-profiles.js'
import type { createVerificationStore } from './verification-store.js'
import { readVerificationVersion } from './verification-worktree.js'

const OUTPUT_LIMIT = 64 * 1024
export const createVerificationExecutor = (input: {
  dataDir: string | null
  store: ReturnType<typeof createVerificationStore>
  logs: ReturnType<typeof createVerificationLogs>
  onChanged: ((workspaceId: string, dispatchId: string) => void) | undefined
}) => {
  const { store, logs } = input
  const execute = async (
    initial: DispatchVerification,
    source: string,
    abort: AbortController,
    execution: ManagedExecution
  ) => {
    let run = initial
    const save = (patch: Partial<DispatchVerification>) => {
      const next = { ...run, ...patch }
      store.save(next)
      run = next
    }
    let output = ''
    let truncated = false
    let lastSaved = 0
    let logBytes = 0
    let writer: ReturnType<typeof logs.writer> | undefined
    const redactor = createVerificationLogRedactor()
    const append = (safe: string) => {
      if (!safe || !writer) return
      logBytes = writer.append(safe)
      if (output.length + safe.length > OUTPUT_LIMIT) truncated = true
      output = (output + safe).slice(-OUTPUT_LIMIT)
    }
    let environment: Awaited<ReturnType<typeof prepareVerificationEnvironment>> | undefined
    try {
      const logWriter = logs.writer(run.id)
      writer = logWriter
      const profile = run.profile ?? legacyVerificationProfile(run.command)
      environment = await prepareVerificationEnvironment({
        execution,
        dataDir: input.dataDir,
        sourcePath: source,
        headSha: run.headSha,
        runId: run.id,
        profile,
      })
      execution.assertReserved()
      const exitCode = await runVerificationCommand({
        cwd: environment.cwd,
        command: [...profile.prepare_commands, profile.command]
          .map((command) => `(${command})`)
          .join(' && '),
        signal: abort.signal,
        execution,
        runId: run.id,
        timeoutMs: profile.timeout_ms,
        env: environment.env,
        launcher: environment.launcher,
        onOutput: (text) => {
          append(redactor.push(text))
          if (Date.now() - lastSaved >= 250) {
            save({ output, outputTruncated: truncated, logBytes })
            lastSaved = Date.now()
          }
        },
      })
      append(redactor.finish())
      save({ exitCode })
      const after = await readVerificationVersion(environment.checkoutRoot)
      const changed = after.headSha !== run.headSha || after.isDirty || !!after.unavailableReason
      await environment.close()
      environment = undefined
      save({
        logBytes,
        state: abort.signal.aborted
          ? 'cancelled'
          : exitCode === 0 && !changed
            ? 'passed'
            : 'failed',
        exitCode,
        error: changed
          ? 'The verification command changed checkout files or HEAD. Commit the intended changes and verify again.'
          : null,
        output,
        outputTruncated: truncated,
        endedAt: Date.now(),
      })
    } catch (error) {
      append(redactor.finish())
      save({
        logBytes,
        state: abort.signal.aborted ? 'cancelled' : 'failed',
        error: redactVerificationLog(error instanceof Error ? error.message : String(error)),
        output,
        outputTruncated: truncated,
        endedAt: Date.now(),
      })
    } finally {
      writer?.close()
      if (environment) await environment.close()
    }
    input.onChanged?.(run.workspaceId, run.dispatchId)
  }
  return execute
}
