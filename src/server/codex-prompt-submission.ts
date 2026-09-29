import type { AgentManager } from './agent-manager.js'
import { checkPendingRemoteInput } from './remote-action-context.js'

const POLL_MS = 50
const SETTLE_MS = 600
const RETRY_MS = 1000
const FLUSH_SETTLE_MS = 100
const TIMEOUT_MS = 20_000
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
const blockingDialog = (screen: string) =>
  /Press enter to confirm|This conversation is open in another app|Do you trust the contents of this directory\?|Hooks need review/iu.test(
    screen
  )

export const completeCodexPasteVisible = (content: string, text: string) => {
  const label = content.split('\n')[0]?.match(/^\s*›\s*\[Pasted Content ([\d,]+) chars\]\s*$/u)
  if (label) return Number(label[1]?.replaceAll(',', '')) === Array.from(text).length
  return content.replace(/\s+/gu, '').includes(text.replace(/\s+/gu, ''))
}

/** Own one paste until its composer clears. A PTY write only queues bytes:
 * Codex can consume the first Enter while still processing a Windows paste.
 * Retry only Enter, only over our visible paste, and stop on any other input.
 * Report delivery additionally requires its durable journal receipt. */
export const submitCodexPrompt = async (
  manager: AgentManager,
  runId: string,
  text: string,
  handleBootstrapScreen?: (screen: string) => boolean
) => {
  const pasteText = text.replace(/\r\n?/gu, '\n')
  let inputSequence = manager.getInputSequence(runId)
  let pasted = false
  let submits = 0
  let lastSubmitAt = 0
  let lastComposer = ''
  let stableSince = 0
  let flushedAt: number | null = null
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    checkPendingRemoteInput(runId, pasted ? 1 : Buffer.byteLength(pasteText))
    const run = manager.getRun(runId)
    if (run.status !== 'starting' && run.status !== 'running')
      throw new Error('Codex stopped before the startup input was submitted.')
    if (manager.getInputSequence(runId) !== inputSequence)
      throw new Error(
        'Other input reached Codex; automatic submission stopped to preserve the draft.'
      )
    const screen = await manager.getTerminalScreen(runId)
    // Screen reads are asynchronous. Recheck ownership immediately before
    // interpreting it or writing Enter, including edits during a resize.
    if (manager.getInputSequence(runId) !== inputSequence)
      throw new Error(
        'Other input reached Codex; automatic submission stopped to preserve the draft.'
      )
    // Onboarding may arrive after the historical prompt-ready marker. Keep
    // the existing directory/hooks bootstrap active until we actually paste.
    if (!pasted && handleBootstrapScreen?.(screen)) {
      inputSequence = manager.getInputSequence(runId)
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      continue
    }
    if (blockingDialog(screen))
      throw new Error('Codex is showing a confirmation dialog; resolve it in the terminal.')
    const input = composer(screen)
    if (!pasted) {
      // A prompt in older output can precede the trust/loading screen.
      // No composer in the current frame is not evidence of a user draft.
      if (input.line) {
        if (!emptyComposer(input.line))
          throw new Error('Codex has an existing draft; startup input was not pasted over it.')
        manager.writeInput(runId, `\u001b[200~${pasteText}\u001b[201~`)
        inputSequence = manager.getInputSequence(runId)
        pasted = true
      }
    } else if (submits > 0 && emptyComposer(input.line)) {
      return
    } else {
      // A stable prefix is not receipt of the complete paste: ConPTY can
      // pause between bursts while only the opening role lines are visible.
      const ownsPaste = completeCodexPasteVisible(input.content, pasteText)
      if (!ownsPaste) stableSince = 0
      else {
        if (input.content !== lastComposer || stableSince === 0) {
          lastComposer = input.content
          stableSince = Date.now()
        }
        if (
          Date.now() - stableSince >= SETTLE_MS &&
          Date.now() - lastSubmitAt >= RETRY_MS &&
          submits < MAX_SUBMITS
        ) {
          if (process.platform === 'win32' && flushedAt === null) {
            // Windows Codex receives paste bursts as individual key events.
            // Right at the end of our own paste is a neutral cursor move,
            // but explicitly flushes its burst buffer. Enter alone can keep
            // extending that buffer instead of submitting the message.
            manager.writeInput(runId, '\u001b[C')
            inputSequence = manager.getInputSequence(runId)
            flushedAt = Date.now()
          } else if (flushedAt === null || Date.now() - flushedAt >= FLUSH_SETTLE_MS) {
            manager.writeInput(runId, '\r')
            inputSequence = manager.getInputSequence(runId)
            lastSubmitAt = Date.now()
            flushedAt = null
            submits += 1
          }
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  throw new Error(
    pasted
      ? submits === 0
        ? 'Codex has not confirmed the complete pasted input; automatic submission stopped.'
        : `Codex has not cleared its pasted input after ${submits} Enter attempts; check the terminal before retrying.`
      : 'Codex has not displayed an input prompt; check the terminal before retrying.'
  )
}
