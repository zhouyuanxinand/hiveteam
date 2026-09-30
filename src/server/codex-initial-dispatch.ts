import { buildWorkerDispatchPayload } from './agent-stdin-dispatcher.js'
import { codexMessageHash } from './codex-message-wire.js'
import type { createDispatchLedgerStore } from './dispatch-ledger-store.js'
import type { DispatchSkillActivationStore } from './dispatch-skill-activation-store.js'
import { ConflictError } from './http-errors.js'
import type { DeliveryRecord, MessageDeliveryStore } from './message-delivery-store.js'
import { executeRemoteInitialInput } from './remote-action-context.js'
import { reportReceiptMarker } from './report-delivery-receipt.js'
import type { Database } from './sqlite.js'
import type { TeamMemoryDigestProvider } from './team-memory-digest.js'
import type { WorkspaceStore } from './workspace-store.js'

export interface CodexInitialDispatchContext {
  workspaceId: string
  agentId: string
  runId: string
  cwd: string
  capturePattern: string
}

export interface CodexInitialDispatchPlan {
  text: string
  launch: <T>(start: () => Promise<T>) => Promise<T>
  launched: () => void
  failed: (error: unknown) => void
}

export type PrepareCodexInitialDispatch = (
  context: CodexInitialDispatchContext
) => CodexInitialDispatchPlan | undefined

/** Claim the same durable dispatch used by the PTY scheduler before spawning.
 * Once argv may have reached a child, only its native receipt can resolve it. */
export const createCodexInitialDispatch =
  (input: {
    db: Database
    records: MessageDeliveryStore
    ledger: ReturnType<typeof createDispatchLedgerStore>
    activations: DispatchSkillActivationStore
    workspaceStore: WorkspaceStore
    memoryDigest?: TeamMemoryDigestProvider['forDispatch']
    authorize: <T>(dispatchId: string, action: () => T) => T
    isClosing: () => boolean
    wake: () => void
  }): PrepareCodexInitialDispatch =>
  (context) => {
    const { workspaceId, agentId, runId, cwd, capturePattern } = context
    const record = input.db
      .prepare(`SELECT * FROM message_deliveries
    WHERE workspace_id=? AND recipient_id=? AND state NOT IN ('confirmed','resolved')
    ORDER BY rowid LIMIT 1`)
      .get(workspaceId, agentId) as DeliveryRecord | undefined
    if (
      !record ||
      record.kind !== 'dispatch' ||
      record.state !== 'pending' ||
      record.write_started ||
      record.checkpoint
    )
      return undefined
    const requireOpen = () => {
      if (input.isClosing()) throw new ConflictError('Runtime is closing')
      const dispatch = input.ledger.getDispatchById(workspaceId, record.dispatch_id)
      if (!dispatch || !['queued', 'failed'].includes(dispatch.status))
        throw new ConflictError('Dispatch closed before the initial prompt could start')
      return dispatch
    }
    const dispatch = input.authorize(record.dispatch_id, requireOpen)
    const worker = input.workspaceStore.getWorker(workspaceId, agentId)
    const sender = dispatch.fromAgentId
      ? input.workspaceStore.getAgent(workspaceId, dispatch.fromAgentId).name
      : 'HiveTeam'
    const body = buildWorkerDispatchPayload(
      sender,
      worker.description,
      dispatch.id,
      dispatch.text,
      input.memoryDigest?.(workspaceId, agentId, dispatch.text, dispatch.id),
      `Hive session binding: workspace_id=${workspaceId}; agent_id=${agentId}`,
      input.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.language ?? 'zh',
      input.activations.get(dispatch.id) ?? undefined,
      dispatch.messageProtocolVersion
    )
    const text = `${body.trimEnd()}\n\n${reportReceiptMarker(record.id)}\n`.replace(/\r\n?/gu, '\n')
    let attempt: number | undefined
    const failed = (error: unknown) => {
      if (attempt === undefined) return
      const reason = error instanceof Error ? error.message : String(error)
      input.records.failed(record.id, attempt, reason)
      input.records.defer(record.id, reason)
      const current = input.ledger.getDispatchById(workspaceId, dispatch.id)
      if (current && ['queued', 'failed'].includes(current.status))
        input.ledger.markDeliveryFailed(dispatch.id, reason)
      input.wake()
    }
    return {
      text,
      failed,
      launched: () => {
        if (attempt === undefined) throw new ConflictError('Initial dispatch was not claimed')
        input.records.awaitingReceipt(record.id, attempt)
        input.wake()
      },
      launch: (start) =>
        input.authorize(record.dispatch_id, async () => {
          requireOpen()
          let started: ReturnType<typeof start> | undefined
          // Keep original remote input authorization/audit around the argv handoff.
          executeRemoteInitialInput(
            runId,
            { workspaceId, agentId },
            Buffer.byteLength(text),
            () => {
              const claimed = input.db
                .transaction(() => {
                  requireOpen()
                  const claimed = input.records.claim(record.id, runId, true)
                  if (!claimed)
                    throw new ConflictError('Initial dispatch was stopped or superseded')
                  input.records.prepared(record.id, claimed.attempt, text)
                  input.records.saveCheckpoint(record.id, claimed.attempt, {
                    cwd,
                    capturePattern,
                    runId,
                    inputSequence: 0,
                    lastSubmitAt: 0,
                    offset: 0,
                    pasteConfirmed: false,
                    sessionFile: null,
                    sessionId: null,
                    wireFormat: 'native-initial-v1',
                    wireSha256: codexMessageHash(text),
                    submitAttempts: 0,
                  })
                  input.records.beforeWrite(record.id, claimed.attempt)
                  return claimed
                })
                .immediate()
              attempt = claimed.attempt
              started = start()
            }
          )
          if (!started) throw new ConflictError('Initial dispatch launch was not authorized')
          return started
        }),
    }
  }
