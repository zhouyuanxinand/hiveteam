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
    expect(turns[0]?.process.map((item) => item.text)).toEqual([
      '正在查看文档',
      'exec_command\n{"cmd":"rg files"}',
    ])
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

test('preserves every final message in order, deduplicates native item replay and completion echoes', () => {
  const final = (id: string, content: string) =>
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id,
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: content }],
      },
    })
  const turns = parseAgentConversation(
    [
      event({ type: 'task_started', turn_id: 'multi' }),
      message('commentary', 'Checking the files'),
      final('answer-1', 'First conclusion.'),
      final('answer-2', 'Second conclusion.'),
      final('answer-1', 'First conclusion.'),
      event({ type: 'task_complete', turn_id: 'multi', last_agent_message: 'Second conclusion.' }),
    ].join('\n')
  )
  expect(turns[0]).toMatchObject({
    status: 'complete',
    answer: 'First conclusion.\n\nSecond conclusion.',
  })
  expect(turns[0]?.process.map((item) => item.text)).toEqual(['Checking the files'])
})

test('associates visible tool arguments and outputs by call id without exposing private or unmatched records', () => {
  const item = (payload: object) => JSON.stringify({ type: 'response_item', payload })
  const turns = parseAgentConversation(
    [
      event({ type: 'task_started', turn_id: 'tools' }),
      item({
        type: 'function_call',
        name: 'exec_command',
        call_id: 'first',
        arguments: '{"cmd":"pwd"}',
      }),
      item({
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'second',
        input: '*** Begin Patch\n*** End Patch',
      }),
      item({ type: 'function_call_output', call_id: 'first', output: 'D:/project' }),
      item({ type: 'custom_tool_call_output', call_id: 'second', output: 'Patch applied' }),
      item({ type: 'function_call_output', call_id: 'first', output: 'D:/project' }),
      item({
        type: 'function_call',
        name: 'exec_command',
        call_id: 'first',
        arguments: '{"cmd":"pwd"}',
      }),
      item({ type: 'function_call_output', call_id: 'unmatched', output: 'UNMATCHED SECRET' }),
      item({ type: 'reasoning', summary: [{ text: 'PRIVATE REASONING' }] }),
      item({ type: 'message', role: 'system', content: [{ text: 'PRIVATE SYSTEM' }] }),
    ].join('\n')
  )
  expect(turns[0]?.status).toBe('running')
  expect(turns[0]?.process).toHaveLength(2)
  expect(turns[0]?.process[0]?.text).toContain('pwd')
  expect(turns[0]?.process[0]?.text).toContain('D:/project')
  expect(turns[0]?.process[1]?.text).toContain('Patch applied')
  expect(JSON.stringify(turns)).not.toMatch(/PRIVATE|UNMATCHED/)
})

test('reports bounded tool and answer data, keeps aborted turns open to inspection, and ignores another turn completion', () => {
  const item = (payload: object) => JSON.stringify({ type: 'response_item', payload })
  const turns = parseAgentConversation(
    [
      event({ type: 'task_started', turn_id: 'bounded' }),
      item({
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call',
        arguments: 'x'.repeat(17000),
      }),
      item({ type: 'function_call_output', call_id: 'call', output: 'tail' }),
      item({
        type: 'message',
        role: 'assistant',
        channel: 'analysis',
        content: [{ text: 'PRIVATE ANALYSIS' }],
      }),
      event({ type: 'task_complete', turn_id: 'other', last_agent_message: 'WRONG ANSWER' }),
      event({ type: 'turn_aborted', turn_id: 'bounded' }),
      event({ type: 'task_started', turn_id: 'long-final' }),
      message('final_answer', 'a'.repeat(130000)),
    ].join('\n')
  )
  expect(turns[0]).toMatchObject({
    status: 'interrupted',
    answer: '',
    truncated: true,
    process: [{ kind: 'tool', truncated: true }],
  })
  expect(turns[0]?.process[0]?.text.length).toBe(16000)
  expect(turns[1]).toMatchObject({ status: 'complete', truncated: true })
  expect(turns[1]?.answer.length).toBe(128000)
  expect(JSON.stringify(turns)).not.toMatch(/PRIVATE|WRONG/)
})

test('retains a distinct public completion message after earlier final messages', () => {
  const turns = parseAgentConversation(
    [
      event({ type: 'task_started', turn_id: 'completion' }),
      message('final_answer', 'Earlier conclusion'),
      event({
        type: 'task_complete',
        turn_id: 'completion',
        last_agent_message: 'Last conclusion',
      }),
      event({
        type: 'task_complete',
        turn_id: 'completion',
        last_agent_message: 'Last conclusion',
      }),
    ].join('\n')
  )
  expect(turns[0]).toMatchObject({
    status: 'complete',
    answer: 'Earlier conclusion\n\nLast conclusion',
  })
})
