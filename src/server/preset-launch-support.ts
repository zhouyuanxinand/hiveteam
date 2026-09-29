import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { findCodexResumeCommandIndex } from './codex-resume-arguments.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import { ConflictError } from './http-errors.js'
import type { SessionCaptureSnapshot } from './session-capture.js'
import { doesCapturedSessionExist, supportsNativeSessionExistenceCheck } from './session-capture.js'

type BoundPreset = Pick<
  CommandPresetRecord,
  'resumeArgsTemplate' | 'sessionIdCapture' | 'yoloArgsTemplate'
>

const getEffectiveCapture = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => config.sessionIdCapture ?? preset?.sessionIdCapture ?? null

const getEffectiveResumeTemplate = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => config.resumeArgsTemplate ?? preset?.resumeArgsTemplate ?? null

const hasResumeArgs = (args: string[]) => {
  return (
    args.includes('--resume') ||
    args.includes('-r') ||
    args.includes('--continue') ||
    args.includes('-c') ||
    args.includes('--session') ||
    args.includes('-s') ||
    args[0] === 'resume'
  )
}

const supportsPresetResume = supportsNativeSessionExistenceCheck

export const withPresetResumeArgs = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined,
  lastSessionId: string | undefined,
  cwd?: string,
  discriminator?: SessionCaptureSnapshot['discriminator']
) => {
  let nextConfig = config
  const sessionIdCapture = getEffectiveCapture(nextConfig, preset)
  if (sessionIdCapture && sessionIdCapture !== nextConfig.sessionIdCapture) {
    nextConfig = { ...nextConfig, sessionIdCapture }
  }

  const resumeArgsTemplate = getEffectiveResumeTemplate(nextConfig, preset)
  if (!lastSessionId || !resumeArgsTemplate) return nextConfig
  if (sessionIdCapture && !supportsPresetResume(sessionIdCapture)) return nextConfig
  if (
    cwd &&
    sessionIdCapture &&
    supportsNativeSessionExistenceCheck(sessionIdCapture) &&
    !doesCapturedSessionExist(cwd, sessionIdCapture, lastSessionId, discriminator)
  ) {
    throw new ConflictError(
      `Saved native session ${lastSessionId} is unavailable or does not belong to this member. Restore its original harness session files and retry. Hive retained the binding and did not start a new conversation.`
    )
  }
  // Do not treat the presence of a Codex `thread-writer-locks/<id>.lock`
  // file as proof that another process still owns the session. Codex uses an
  // OS-level file lock, and its own startup path probes that lock and removes
  // files left behind by a crashed process. A plain existence check here made
  // every machine restart look like an active-writer conflict, so Hive skipped
  // `codex resume` and silently opened a new conversation instead.
  //
  // The native CLI remains the authority for genuine concurrent ownership: it
  // will return its active-writer error without causing Hive to discard the
  // persisted session pointer.
  const args = config.args ?? []
  const codex = sessionIdCapture?.source === 'codex_session_jsonl_dir'
  const codexResumeIndex = codex ? findCodexResumeCommandIndex(args) : -1
  if (codex ? codexResumeIndex >= 0 : hasResumeArgs(args)) {
    if (codex && args[codexResumeIndex + 1] === lastSessionId)
      return { ...nextConfig, resumedSessionId: lastSessionId }
    return nextConfig
  }
  const resumeArgs = resumeArgsTemplate.replace('{session_id}', lastSessionId).trim().split(/\s+/)

  return {
    ...nextConfig,
    args: resumeArgs.concat(args),
    resumeArgsTemplate,
    resumedSessionId: lastSessionId,
  } satisfies AgentLaunchConfigInput
}
