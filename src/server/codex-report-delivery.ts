import type { AgentManager } from './agent-manager.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import {
  assertReportSession,
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
}: {
  agentManager: AgentManager
  agentId: string
  workspaceId: string
  runId: string
  text: string
  receipt: ReportDeliveryReceipt
  sessions: AgentSessionStorePort
  waitMs?: number
}) => {
  const marker = reportReceiptMarker(receipt.id)
  let checkpoint = receipt.checkpoint
  const save = (next: ReportDeliveryCheckpoint) => {
    receipt.save(next)
    checkpoint = next
  }
  if (checkpoint) assertReportSession(checkpoint.sessionFile, checkpoint.sessionId, checkpoint.cwd)
  let readReceipt = checkpoint
    ? createReportJournalReader(checkpoint.sessionFile, checkpoint.offset, marker)
    : undefined
  let size = agentManager.getTerminalSize(runId)
  const mirror = new TerminalStateMirror(size)
  mirror.write(agentManager.getRun(runId).output)
  const unsubscribe = agentManager.getOutputBus().subscribe(runId, (chunk) => mirror.write(chunk))
  const deadline = Date.now() + (waitMs ?? WAIT_MS)
  try {
    while (Date.now() < deadline) {
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
          'Orchestrator stopped before Codex confirmed the report. The report remains queued.'
        )
      if (checkpoint && checkpoint.runId !== runId)
        throw new Error(
          'The previous terminal ended with an unconfirmed report. Review its session before resending; Hive has retained the report without duplicating it.'
        )
      const screen = await mirror.getScreenText()
      if (
        /Press enter to confirm|This conversation is open in another app|Do you trust the contents of this directory\?|Hooks need review/iu.test(
          screen
        )
      )
        throw new Error(
          'Codex is showing a confirmation or session-lock dialog. Resolve it in the Orchestrator; Hive will not automatically confirm it. The report remains queued.'
        )
      const input = composer(screen)
      if (!checkpoint) {
        const context = sessions.getCaptureContext(workspaceId, agentId)
        const sessionId = sessions.getLastSessionId(workspaceId, agentId)
        if (
          emptyComposer(input.line) &&
          context?.capture.source === 'codex_session_jsonl_dir' &&
          sessionId
        ) {
          const sessionFile = findReportSession(context.capture.pattern, sessionId, context.cwd)
          const offset = reportJournalOffset(sessionFile)
          save({
            cwd: context.cwd,
            inputSequence: agentManager.getInputSequence(runId) + 1,
            lastSubmitAt: 0,
            offset,
            pasteConfirmed: false,
            runId,
            sessionFile,
            sessionId,
            submitAttempts: 0,
          })
          readReceipt = createReportJournalReader(sessionFile, offset, marker)
          agentManager.writeInput(
            runId,
            toBracketedPasteSubmission(`${text.trimEnd()}\n\n${marker}\n`)
          )
        }
      } else {
        if (agentManager.getInputSequence(runId) !== checkpoint.inputSequence)
          throw new Error(
            'Other input reached the Orchestrator while a report was pending. Review its composer; Hive will not overwrite or submit your draft. The report remains queued.'
          )
        if (pastedComposer(input, marker)) {
          if (!checkpoint.pasteConfirmed) save({ ...checkpoint, pasteConfirmed: true })
          if (
            checkpoint.submitAttempts < MAX_SUBMITS &&
            Date.now() - checkpoint.lastSubmitAt >= SUBMIT_INTERVAL_MS
          ) {
            save({
              ...checkpoint,
              inputSequence: checkpoint.inputSequence + 1,
              lastSubmitAt: Date.now(),
              submitAttempts: checkpoint.submitAttempts + 1,
            })
            agentManager.writeInput(runId, '\r')
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    throw new Error(
      checkpoint
        ? 'Codex has not confirmed receipt of the report. Open the Orchestrator and check its pasted message or blocking dialog; the report remains queued and will not be pasted twice.'
        : 'Waiting for the bound Codex session and an empty composer. Finish any current input or dialog; the report remains queued.'
    )
  } finally {
    unsubscribe()
    mirror.dispose()
  }
}
