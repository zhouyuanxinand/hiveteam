import type { AgentManager } from './agent-manager.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import {
  codexMessageHash,
  codexReceiptHash,
  completeCodexEncodedPasteVisible,
  completeCodexTextPasteVisible,
  encodeCodexMessage,
} from './codex-message-wire.js'
import { completeCodexPasteVisible } from './codex-prompt-submission.js'
import { resolveCodexReceiptSession } from './codex-receipt-session.js'
import {
  createReportJournalReader,
  findReportSession,
  reportJournalOffset,
} from './codex-report-journal.js'
import { toBracketedPasteSubmission } from './post-start-input-writer.js'
import {
  type ReportDeliveryCheckpoint,
  type ReportDeliveryReceipt,
  reportReceiptMarker,
} from './report-delivery-receipt.js'
import { TerminalStateMirror } from './terminal-state-mirror.js'

const WAIT_MS = 15_000
const POLL_MS = 100
const SUBMIT_INTERVAL_MS = 1_000
const MAX_SUBMITS = 3

const composer = (screen: string) => {
  const lines = screen.split('\n')
  let start = lines.length - 1
  while (start >= 0 && !/^\s*›/u.test(lines[start] ?? '')) start -= 1
  return {
    line: start < 0 ? '' : (lines[start]?.trim() ?? ''),
    content: start < 0 ? '' : lines.slice(start).join('\n'),
  }
}
const emptyComposer = (line: string) => /^›\s*(?:Ask Codex to do anything)?\s*$/u.test(line)
const pastedComposer = (input: ReturnType<typeof composer>, marker: string) =>
  input.content.includes(marker) || /^›\s*\[Pasted Content [\d,]+ chars\]/u.test(input.line)

/** A report is delivered only when Codex journals the tagged user message.
 * Checkpoints precede all input writes. Retries submit the existing paste,
 * never re-paste a message whose acceptance is uncertain. */
export const deliverCodexReport = async ({
  agentManager,
  agentId,
  workspaceId,
  runId,
  text,
  receipt,
  sessions,
  waitMs,
  onPrepared,
  allowUnboundSession = false,
}: {
  agentManager: AgentManager
  agentId: string
  workspaceId: string
  runId: string
  text: string
  receipt: ReportDeliveryReceipt
  sessions: AgentSessionStorePort
  waitMs?: number
  onPrepared?: (payload: string) => void
  allowUnboundSession?: boolean
}) => {
  const marker = reportReceiptMarker(receipt.id)
  const payload = `${text.trimEnd()}\n\n${marker}\n`.replace(/\r\n?/gu, '\n')
  let checkpoint = receipt.checkpoint
  if (checkpoint?.wireFormat === 'native-initial-v1')
    throw new Error(
      'This message was passed to Codex at launch; only its native receipt can confirm it. It will not be pasted again.'
    )
  const encoded = checkpoint
    ? codexReceiptHash(checkpoint) !== undefined
    : process.platform === 'win32'
  const wire = encoded ? encodeCodexMessage(payload) : payload
  const wireHash = encoded ? codexMessageHash(wire) : undefined
  if (checkpoint && encoded && codexReceiptHash(checkpoint) !== wireHash)
    throw new Error(
      'Codex delivery payload changed after its checkpoint; the existing draft was preserved.'
    )
  const save = (next: ReportDeliveryCheckpoint) => {
    receipt.save(next)
    checkpoint = next
  }
  let readReceipt: ReturnType<typeof createReportJournalReader> | undefined
  let flushedAt: number | null = null
  let size = agentManager.getTerminalSize(runId)
  const mirror = new TerminalStateMirror(size)
  mirror.write(agentManager.getRun(runId).output)
  const unsubscribe = agentManager.getOutputBus().subscribe(runId, (chunk) => mirror.write(chunk))
  const deadline = Date.now() + (waitMs ?? WAIT_MS)
  try {
    while (Date.now() < deadline) {
      if (checkpoint && !readReceipt) {
        const bound = resolveCodexReceiptSession(
          checkpoint,
          sessions.getLastSessionId(workspaceId, agentId),
          workspaceId,
          agentId
        )
        if (bound) {
          if (checkpoint.sessionId !== bound.sessionId) save(bound)
          readReceipt = createReportJournalReader(
            bound.sessionFile,
            bound.offset,
            marker,
            codexReceiptHash(bound)
          )
        }
      }
      const nextSize = agentManager.getTerminalSize(runId)
      if (size.cols !== nextSize.cols || size.rows !== nextSize.rows) {
        mirror.resize(nextSize.cols, nextSize.rows)
        size = nextSize
      }
      const journal = readReceipt?.()
      if (journal?.found) return
      if (journal && !journal.caughtUp) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        continue
      }
      const run = agentManager.getRun(runId)
      if (run.status !== 'starting' && run.status !== 'running')
        throw new Error(
          'The recipient stopped before Codex confirmed the message. The message remains queued.'
        )
      if (checkpoint && checkpoint.runId !== runId)
        throw new Error(
          'The previous terminal ended with an unconfirmed message. Review its session before resending; HiveTeam has retained the message without duplicating it.'
        )
      const screen = await mirror.getScreenText()
      if (
        /Press enter to confirm|This conversation is open in another app|Do you trust the contents of this directory\?|Hooks need review/iu.test(
          screen
        )
      )
        throw new Error(
          'Codex is showing a confirmation or session-lock dialog. Resolve it in the recipient terminal; HiveTeam will not automatically confirm it. The message remains queued.'
        )
      const input = composer(screen)
      if (!checkpoint) {
        const context = sessions.getCaptureContext(workspaceId, agentId)
        const sessionId = sessions.getLastSessionId(workspaceId, agentId)
        if (
          emptyComposer(input.line) &&
          context?.capture.source === 'codex_session_jsonl_dir' &&
          (sessionId || allowUnboundSession)
        ) {
          const sessionFile = sessionId
            ? findReportSession(context.capture.pattern, sessionId, context.cwd)
            : null
          const offset = sessionFile ? reportJournalOffset(sessionFile) : 0
          onPrepared?.(wire)
          save({
            cwd: context.cwd,
            inputSequence: agentManager.getInputSequence(runId) + 1,
            lastSubmitAt: 0,
            offset,
            pasteConfirmed: false,
            runId,
            sessionFile,
            sessionId: sessionId ?? null,
            ...(!sessionId ? { capturePattern: context.capture.pattern } : {}),
            ...(wireHash ? { wireFormat: 'json-string-v1' as const, wireSha256: wireHash } : {}),
            submitAttempts: 0,
          })
          if (sessionFile)
            readReceipt = createReportJournalReader(sessionFile, offset, marker, wireHash)
          agentManager.writeInput(runId, toBracketedPasteSubmission(wire))
        }
      } else {
        if (agentManager.getInputSequence(runId) !== checkpoint.inputSequence)
          throw new Error(
            'Other input reached the recipient while a message was pending. Review its composer; HiveTeam will not overwrite or submit your draft. The message remains queued.'
          )
        if (
          encoded
            ? completeCodexEncodedPasteVisible(input.content, wire)
            : checkpoint.capturePattern
              ? completeCodexPasteVisible(input.content, payload)
              : pastedComposer(input, marker) ||
                completeCodexTextPasteVisible(input.content, payload)
        ) {
          if (!checkpoint.pasteConfirmed) save({ ...checkpoint, pasteConfirmed: true })
          if (
            checkpoint.submitAttempts < MAX_SUBMITS &&
            Date.now() - checkpoint.lastSubmitAt >= SUBMIT_INTERVAL_MS
          ) {
            if ((encoded || checkpoint.capturePattern) && process.platform === 'win32') {
              if (flushedAt === null) {
                save({ ...checkpoint, inputSequence: checkpoint.inputSequence + 1 })
                agentManager.writeInput(runId, '\u001b[C')
                flushedAt = Date.now()
                continue
              }
              if (Date.now() - flushedAt < 100) {
                await new Promise((resolve) => setTimeout(resolve, POLL_MS))
                continue
              }
            }
            save({
              ...checkpoint,
              inputSequence: checkpoint.inputSequence + 1,
              lastSubmitAt: Date.now(),
              submitAttempts: checkpoint.submitAttempts + 1,
            })
            agentManager.writeInput(runId, '\r')
            flushedAt = null
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    throw new Error(
      checkpoint
        ? 'Codex has not confirmed receipt of the message. Open the recipient terminal and check its pasted message or blocking dialog; the message remains queued and will not be pasted twice.'
        : 'Waiting for the bound Codex session and an empty composer. Finish any current input or dialog; the message remains queued.'
    )
  } finally {
    unsubscribe()
    mirror.dispose()
  }
}
