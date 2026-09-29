import type { AgentConversation } from '../../../src/shared/agent-conversation.js'
import type { TerminalHistoryBlock } from './terminal-process-bounds.js'
import type { TerminalProcessLabels } from './terminal-process-fold.js'

/** Only a run-bound, public transcript may label a turn complete. PTY text cannot. */
export const conversationHistory = (
  conversation: AgentConversation | undefined,
  runId: string,
  labels: TerminalProcessLabels
): TerminalHistoryBlock[] | undefined => {
  if (conversation?.status !== 'ready' || conversation.run_id !== runId) return undefined
  if (!conversation.turns.length) return undefined
  const blocks: TerminalHistoryBlock[] = []
  if (conversation.truncated)
    blocks.push({ id: 'truncated', kind: 'notice', text: labels.truncated })
  for (const turn of conversation.turns) {
    const prefix = `${conversation.session_id}:${turn.id}`
    if (turn.prompt) blocks.push({ id: `${prefix}:prompt`, kind: 'prompt', text: turn.prompt })
    if (turn.process.length || turn.status === 'running') {
      blocks.push({
        id: `${prefix}:process`,
        kind: 'process',
        phase: turn.status,
        text: turn.process
          .map((item) => `${item.text}${item.truncated ? `\n${labels.truncated}` : ''}`)
          .join('\n\n'),
      })
    }
    if (turn.answer) blocks.push({ id: `${prefix}:answer`, kind: 'message', text: turn.answer })
    if (turn.truncated)
      blocks.push({ id: `${prefix}:truncated`, kind: 'notice', text: labels.truncated })
    if (turn.status === 'interrupted')
      blocks.push({ id: `${prefix}:interrupted`, kind: 'notice', text: labels.interrupted })
  }
  return blocks
}
