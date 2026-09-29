import type { ConversationTurn } from '../shared/agent-conversation.js'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const messageText = (content: unknown) =>
  Array.isArray(content)
    ? content
        .map((item) => text(record(item).text))
        .filter(Boolean)
        .join('\n')
    : ''
const TOOL_LIMIT = 16_000
const ANSWER_LIMIT = 128_000

/** Only visible messages and tool I/O are projected; reasoning and system records are ignored. */
export const parseAgentConversationTranscript = (
  jsonl: string
): { turns: ConversationTurn[]; truncated: boolean } => {
  const turns: ConversationTurn[] = []
  let truncated = false
  let sequence = 0
  let processSequence = 0
  let current: ConversationTurn | undefined
  let finals = new Map<string, string>()
  let calls = new Map<string, ConversationTurn['process'][number]>()
  let outputs = new Set<string>()
  const markTruncated = (turn: ConversationTurn) => {
    turn.truncated = true
    truncated = true
  }
  const bounded = (turn: ConversationTurn, value: string, limit: number) => {
    if (value.length > limit) markTruncated(turn)
    return value.slice(0, limit)
  }
  const begin = (id: string) => {
    if (current?.id === id) return current
    current = { id, prompt: '', process: [], answer: '', status: 'running' }
    processSequence = 0
    finals = new Map()
    calls = new Map()
    outputs = new Set()
    turns.push(current)
    if (turns.length > 20) {
      turns.shift()
      truncated = true
    }
    return current
  }
  const processItem = (turn: ConversationTurn, kind: 'commentary' | 'tool', value: string) => {
    if (!value) return undefined
    const item: ConversationTurn['process'][number] = {
      id: `${turn.id}-process-${processSequence++}`,
      kind,
      text: bounded(turn, value, TOOL_LIMIT),
      ...(value.length > TOOL_LIMIT ? { truncated: true } : {}),
    }
    turn.process.push(item)
    if (turn.process.length > 50) {
      turn.process.shift()
      markTruncated(turn)
    }
    return item
  }
  const answer = (turn: ConversationTurn, id: string, content: string) => {
    if (!content) return
    finals.set(id, content)
    turn.answer = bounded(turn, [...finals.values()].join('\n\n'), ANSWER_LIMIT)
    turn.process = turn.process.filter(
      (item) => item.kind !== 'commentary' || ![...finals.values()].includes(item.text)
    )
  }
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let item: Record<string, unknown>
    try {
      item = record(JSON.parse(line))
    } catch (error) {
      if (error instanceof SyntaxError) continue // A native append can end in an incomplete record.
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
    if (!current) {
      if (
        item.type !== 'response_item' ||
        payload.type !== 'message' ||
        payload.role !== 'assistant'
      )
        continue
      markTruncated(begin('partial-turn'))
    }
    const turn = current as ConversationTurn
    if (typeof payload.turn_id === 'string' && payload.turn_id !== turn.id) continue
    if (item.type === 'event_msg') {
      if (payload.type === 'user_message') turn.prompt = bounded(turn, text(payload.message), 4000)
      if (payload.type === 'task_complete') {
        const lastMessage = text(payload.last_agent_message)
        if (
          lastMessage &&
          lastMessage !== turn.answer &&
          ![...finals.values()].includes(lastMessage)
        )
          answer(turn, 'completion', lastMessage)
        turn.status = 'complete'
      }
      if (payload.type === 'turn_aborted') turn.status = 'interrupted'
      continue
    }
    if (payload.type === 'message' && payload.role === 'user' && !turn.prompt)
      turn.prompt = bounded(turn, messageText(payload.content), 4000)
    if (payload.type === 'message' && payload.role === 'assistant') {
      if (payload.channel === 'analysis' || payload.phase === 'analysis') continue
      const content = messageText(payload.content)
      if (payload.phase === 'final_answer' || payload.channel === 'final') {
        answer(turn, text(payload.id) || content, content)
        turn.status = 'complete'
      } else if (turn.process.at(-1)?.text !== content) processItem(turn, 'commentary', content)
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const callId = text(payload.call_id)
      if (callId && calls.has(callId)) continue
      const content = [text(payload.name), text(payload.arguments) || text(payload.input)]
        .filter(Boolean)
        .join('\n')
      const entry = processItem(turn, 'tool', content)
      if (callId && entry) calls.set(callId, entry)
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const entry = calls.get(text(payload.call_id))
      if (!entry || !turn.process.includes(entry) || outputs.has(text(payload.call_id))) continue
      const output = text(payload.output) || messageText(payload.output)
      if (!output) continue
      const combined = `${entry.text}\n\n${output}`
      entry.text = bounded(turn, combined, TOOL_LIMIT)
      if (combined.length > TOOL_LIMIT) entry.truncated = true
      outputs.add(text(payload.call_id))
    }
  }
  return {
    turns: turns.filter((turn) => turn.prompt || turn.process.length || turn.answer),
    truncated,
  }
}

export const parseAgentConversation = (jsonl: string): ConversationTurn[] =>
  parseAgentConversationTranscript(jsonl).turns
