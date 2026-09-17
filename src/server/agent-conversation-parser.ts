import type { ConversationTurn } from '../shared/agent-conversation.js'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown, limit = 16_000) =>
  typeof value === 'string' ? value.slice(0, limit) : ''
const messageText = (content: unknown) =>
  Array.isArray(content)
    ? content
        .map((item) => text(record(item).text))
        .join('\n')
        .slice(0, 32_000)
    : ''

/** Read only user-visible messages and tool names, never private reasoning or system prompts. */
export const parseAgentConversation = (jsonl: string): ConversationTurn[] => {
  const turns: ConversationTurn[] = []
  let sequence = 0
  let processSequence = 0
  let current: ConversationTurn | undefined
  const begin = (id: string) => {
    if (current?.id === id) return current
    current = { id, prompt: '', process: [], answer: '', status: 'running' }
    processSequence = 0
    turns.push(current)
    if (turns.length > 20) turns.shift()
    return current
  }
  const processItem = (turn: ConversationTurn, kind: 'commentary' | 'tool', value: string) => {
    if (!value || turn.process.at(-1)?.text === value) return
    turn.process.push({
      id: `${turn.id}-process-${processSequence++}`,
      kind,
      text: value.slice(0, 2000),
    })
    if (turn.process.length > 50) turn.process.shift()
  }
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let item: Record<string, unknown>
    try {
      item = record(JSON.parse(line))
    } catch (error) {
      if (error instanceof SyntaxError) continue // Native logs can end in a partial append.
      throw error
    }
    const payload = record(item.payload)
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      begin(text(payload.turn_id) || `turn-${sequence++}`)
      continue
    }
    if (item.type === 'turn_context' && typeof payload.turn_id === 'string') {
      begin(payload.turn_id)
      continue
    }
    if (item.type !== 'event_msg' && item.type !== 'response_item') continue
    // A bounded tail can start in the middle of a turn. Do not fabricate a completed answer.
    if (!current) {
      if (item.type !== 'response_item' || payload.role !== 'assistant') continue
      begin('partial-turn')
    }
    const turn = current as ConversationTurn
    if (item.type === 'event_msg') {
      if (payload.type === 'user_message') turn.prompt = text(payload.message, 4000)
      if (payload.type === 'task_complete') {
        if (!turn.answer) turn.answer = text(payload.last_agent_message, 32_000)
        turn.process = turn.process.filter((item) => item.text !== turn.answer)
        turn.status = 'complete'
      }
      if (payload.type === 'turn_aborted') turn.status = 'interrupted'
      continue
    }
    if (payload.type === 'message' && payload.role === 'user' && !turn.prompt)
      turn.prompt = messageText(payload.content).slice(0, 4000)
    if (payload.type === 'message' && payload.role === 'assistant') {
      const content = messageText(payload.content)
      if (payload.phase === 'final_answer' || payload.channel === 'final') {
        turn.answer = content
        turn.status = 'complete'
      } else processItem(turn, 'commentary', content)
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call')
      processItem(turn, 'tool', text(payload.name, 150))
  }
  return turns.filter((turn) => turn.prompt || turn.process.length || turn.answer)
}
