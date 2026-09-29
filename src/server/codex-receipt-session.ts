import { assertReportSession, findReportSession } from './codex-report-journal.js'
import type { ReportDeliveryCheckpoint } from './report-delivery-receipt.js'
import { hasCodexSession } from './session-capture-codex.js'

export type BoundReceiptCheckpoint = ReportDeliveryCheckpoint & {
  sessionId: string
  sessionFile: string
}

/** Complete a first-prompt checkpoint only from the member's captured binding.
 * Never select another conversation merely because it has the same directory. */
export const resolveCodexReceiptSession = (
  checkpoint: ReportDeliveryCheckpoint,
  capturedSessionId: string | undefined,
  workspaceId: string,
  agentId: string
): BoundReceiptCheckpoint | undefined => {
  if (checkpoint.sessionId && checkpoint.sessionFile) {
    assertReportSession(checkpoint.sessionFile, checkpoint.sessionId, checkpoint.cwd)
    return { ...checkpoint, sessionId: checkpoint.sessionId, sessionFile: checkpoint.sessionFile }
  }
  if (!capturedSessionId || !checkpoint.capturePattern) return undefined
  if (
    !hasCodexSession(checkpoint.cwd, capturedSessionId, checkpoint.capturePattern, {
      contentIncludes: `Hive session binding: workspace_id=${workspaceId}; agent_id=${agentId}`,
    })
  )
    return undefined
  return {
    ...checkpoint,
    sessionId: capturedSessionId,
    sessionFile: findReportSession(checkpoint.capturePattern, capturedSessionId, checkpoint.cwd),
    // This journal did not exist before the first write; its tagged user
    // message can be the first message. The receipt UUID must still match.
    offset: 0,
  }
}
