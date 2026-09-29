import { join } from 'node:path'

import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import { buildAgentSessionBindingMarker } from './agent-startup-instructions.js'
import { ConflictError } from './http-errors.js'
import {
  doesCapturedSessionExist,
  type SessionCaptureSnapshot,
  type SessionIdCaptureConfig,
  snapshotSessionIdsForCapture,
} from './session-capture.js'

const pinCaptureLocation = (capture: SessionIdCaptureConfig, root: string) => {
  switch (capture.source) {
    case 'claude_project_jsonl_dir':
      return { ...capture, pattern: join(root, '{encoded_cwd}', '*.jsonl') }
    case 'codex_session_jsonl_dir':
      return { ...capture, pattern: join(root, 'sessions', '**', '*.jsonl') }
    case 'gemini_session_json_dir':
      return { ...capture, pattern: join(root, 'tmp', '*', 'chats', '*.json') }
    case 'opencode_session_db':
      return { ...capture, pattern: root }
    default:
      return capture
  }
}

// A cwd is not an agent identity: desktop conversations and other Hive members
// can share it. Only recover unrecorded sessions carrying the member's marker.
export const prepareAgentSessionRecovery = ({
  agentId,
  capture,
  cwd,
  discriminator,
  sessionStore,
  workspaceId,
}: {
  agentId: string
  capture: SessionIdCaptureConfig | null | undefined
  cwd: string
  discriminator: SessionCaptureSnapshot['discriminator']
  sessionStore: AgentSessionStorePort
  workspaceId: string
}) => {
  const context = sessionStore.getCaptureContext(workspaceId, agentId)
  if (
    context &&
    (context.platform !== process.platform ||
      context.cwd !== cwd ||
      context.capture.source !== capture?.source)
  ) {
    throw new ConflictError(
      'Saved session environment differs from this launch. Use the original harness, working directory and Windows/WSL environment to resume; the saved conversation has been retained.'
    )
  }
  const effectiveCapture = context?.capture ?? capture
  const snapshot = snapshotSessionIdsForCapture(cwd, effectiveCapture, discriminator)
  if (!snapshot?.root || !effectiveCapture) return { capture: effectiveCapture, snapshot }
  const pinnedCapture = pinCaptureLocation(effectiveCapture, snapshot.root)
  let sessionId = sessionStore.getLastSessionId(workspaceId, agentId)
  if (
    !sessionId &&
    discriminator &&
    (pinnedCapture.source === 'codex_session_jsonl_dir' ||
      pinnedCapture.source === 'claude_project_jsonl_dir')
  ) {
    const known = new Set(context?.knownSessionIds ?? [])
    const stableIdentity = {
      contentIncludes: buildAgentSessionBindingMarker({
        agent: { id: agentId },
        workspace: { id: workspaceId },
      }),
    }
    const candidates = [...snapshot.knownSessionIds].filter(
      (id) => !known.has(id) && doesCapturedSessionExist(cwd, pinnedCapture, id, stableIdentity)
    )
    if (candidates.length > 1) {
      throw new ConflictError(
        'Multiple native conversations match this member. Select the intended conversation in the harness before retrying; Hive has not opened a new conversation.'
      )
    }
    sessionId = candidates[0]
    if (sessionId) sessionStore.setLastSessionId(workspaceId, agentId, sessionId)
  }
  const recoveredSessionId =
    pinnedCapture.source === 'codex_session_jsonl_dir' && context?.recoveredSessionId === sessionId
      ? sessionId
      : undefined
  return {
    capture: pinnedCapture,
    snapshot,
    explicitlyRecovered: recoveredSessionId !== undefined,
    commitContext: () =>
      sessionStore.saveCaptureContext(workspaceId, agentId, {
        capture: pinnedCapture,
        cwd,
        knownSessionIds: context?.knownSessionIds ?? [...snapshot.knownSessionIds],
        platform: process.platform,
        ...(recoveredSessionId ? { recoveredSessionId } : {}),
      }),
  }
}
