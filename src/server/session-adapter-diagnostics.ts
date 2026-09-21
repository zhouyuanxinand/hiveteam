import type {
  InstalledSessionAdapterReport,
  SessionCliDiagnostic,
  SessionCliTranscript,
  SessionHarness,
} from '../shared/session-adapter.js'
import { resolveCommandPath } from './agent-command-resolver.js'
import { BadRequestError } from './http-errors.js'
import { describeSessionAdapter } from './session-adapter-capabilities.js'

export class SessionDiagnosticInputError extends BadRequestError {
  readonly code = 'invalid_session_diagnostic'
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const transcript = (value: unknown, limit: number): SessionCliTranscript => {
  if (
    !record(value) ||
    !(
      value.exit_code === null ||
      (Number.isInteger(value.exit_code) &&
        typeof value.exit_code === 'number' &&
        value.exit_code >= 0 &&
        value.exit_code <= 255)
    ) ||
    typeof value.stdout !== 'string' ||
    typeof value.stderr !== 'string' ||
    value.stdout.length + value.stderr.length > limit
  ) {
    throw new SessionDiagnosticInputError(
      'Each diagnostic requires a bounded stdout/stderr and an exit_code (0–255 or null).'
    )
  }
  return { exit_code: value.exit_code, stdout: value.stdout, stderr: value.stderr }
}

export const readSessionDiagnostic = (
  harness: SessionHarness,
  value: unknown
): SessionCliDiagnostic => {
  const adapter = describeSessionAdapter(harness)
  if (
    !record(value) ||
    typeof value.command !== 'string' ||
    !adapter.commands.includes(value.command) ||
    (value.platform !== 'win32' && value.platform !== 'linux' && value.platform !== 'darwin')
  ) {
    throw new SessionDiagnosticInputError(
      'Use a documented command name and platform (win32, linux or darwin). No command is executed.'
    )
  }
  return {
    command: value.command,
    platform: value.platform,
    version: transcript(value.version, 4096),
    help: transcript(value.help, 49152),
  }
}

/** Resolves executable locations only. Never executes a CLI or opens its session store. */
export const inspectInstalledSessionAdapter = (
  harness: SessionHarness,
  cwd: string,
  env: NodeJS.ProcessEnv
): InstalledSessionAdapterReport => {
  const report = describeSessionAdapter(harness)
  return {
    ...report,
    runtime_platform: process.platform,
    command_locations: report.commands.map((command) => {
      try {
        return {
          command,
          status: 'resolved' as const,
          path: resolveCommandPath(command, cwd, env),
          error_code: null,
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'ENOEXEC') throw error
        return {
          command,
          status: code === 'ENOENT' ? ('missing' as const) : ('unusable' as const),
          path: null,
          error_code: code,
        }
      }
    }),
  }
}
