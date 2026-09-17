import { describe, expect, test } from 'vitest'
import { parseAgentConversation } from '../../src/server/agent-conversation-parser.js'

const event = (payload: object) => JSON.stringify({ type: 'event_msg', payload })
const message = (phase: string, text: string) =>
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase,
      content: [{ type: 'output_text', text }],
    },
  })

describe('native conversation turns', () => {
  test('keeps the final answer outside the completed process and ignores private records', () => {
    const turns = parseAgentConversation(
      [
        event({ type: 'task_started', turn_id: 'turn-1' }),
        event({ type: 'user_message', message: '分析文档' }),
        message('commentary', '正在查看文档'),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'reasoning', encrypted_content: 'PRIVATE', summary: [] },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg files"}' },
        }),
        message('final_answer', '结论：需要补充验收条件。'),
        event({
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: '结论：需要补充验收条件。',
        }),
      ].join('\n')
    )
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      id: 'turn-1',
      status: 'complete',
      answer: '结论：需要补充验收条件。',
      prompt: '分析文档',
    })
    expect(turns[0]?.process.map((item) => item.text)).toEqual(['正在查看文档', 'exec_command'])
    expect(JSON.stringify(turns)).not.toContain('PRIVATE')
  })
  test('does not treat commentary or interrupted turns as a final answer', () => {
    expect(
      parseAgentConversation(
        [
          event({ type: 'task_started', turn_id: 'a' }),
          message('commentary', '尚在检查'),
          event({ type: 'turn_aborted' }),
        ].join('\n')
      )[0]
    ).toMatchObject({ status: 'interrupted', answer: '' })
  })
  test('keeps turn boundaries, accepts incomplete tail records and limits old turns', () => {
    const lines = Array.from({ length: 25 }, (_, i) => [
      event({ type: 'task_started', turn_id: `t-${i}` }),
      message('final_answer', `answer ${i}`),
      event({ type: 'task_complete', turn_id: `t-${i}` }),
    ]).flat()
    const turns = parseAgentConversation(`${lines.join('\n')}\n{"type":`)
    expect(turns).toHaveLength(20)
    expect(turns.at(-1)?.answer).toBe('answer 24')
    expect(turns[0]?.id).toBe('t-5')
  })
})
