import type { AgentRunExitContext } from './agent-run-start-context.js'
import { completeLiveRun } from './agent-run-sync.js'
import { doesCapturedSessionExist, supportsNativeSessionExistenceCheck } from './session-capture.js'

interface HandleRunExitInput {
  exitCode: number | null
  endedAt: number
  runId: string
}

export const clearResumedSessionIfInvalid = (
  context: Pick<
    AgentRunExitContext,
    'agentId' | 'sessionStore' | 'sessionCaptureDiscriminator' | 'startConfig' | 'workspace'
  >,
  exitCode: number | null
) => {
  const sessionId = context.startConfig.resumedSessionId
  const capture = context.startConfig.sessionIdCapture
  if (exitCode === 0 || !sessionId || !supportsNativeSessionExistenceCheck(capture)) return
  if (
    doesCapturedSessionExist(
      context.workspace.path,
      capture,
      sessionId,
      context.sessionCaptureDiscriminator
    )
  ) {
    return
  }
  context.sessionStore.clearLastSessionId(context.workspace.id, context.agentId)
}

export const handleAgentRunExit = (
  context: AgentRunExitContext,
  { exitCode, endedAt, runId }: HandleRunExitInput
) => {
  context.registry.setPendingExitCode(runId, exitCode)
  const liveRun = context.registry.get(runId)
  if (!liveRun) {
    context.tokenRegistry.revokeIfMatches(context.agentId, context.token)
    return false
  }
  if (context.handledRunExits.has(runId)) {
    context.registry.clearPendingExitCode(runId)
    return false
  }

  completeLiveRun(liveRun, exitCode, endedAt, context.store)
  clearResumedSessionIfInvalid(context, exitCode)
  context.handledRunExits.add(runId)
  context.tokenRegistry.revokeIfMatches(context.agentId, context.token)
  context.onAgentExit(context.workspace.id, context.agentId)
  context.registry.resolveExit(runId)
  context.registry.clearPendingExitCode(runId)
  return true
}
