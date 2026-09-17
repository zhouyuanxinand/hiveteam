import { Terminal } from '@xterm/headless'
import { afterEach, expect, test } from 'vitest'
import type { ConversationTurn } from '../../src/shared/agent-conversation.js'
import { findTerminalProcessBounds } from '../../web/src/terminal/terminal-process-bounds.js'

const terminals: Terminal[] = []
const turn: ConversationTurn = {
  id: 'turn',
  prompt: '请分析技术文档',
  answer: '已安排成员分析技术文档。',
  status: 'complete',
  process: [{ id: 'tool', kind: 'tool', text: 'exec_command' }],
}
const fixture = async (cols = 80) => {
  const terminal = new Terminal({ cols, rows: 12, allowProposedApi: true })
  terminals.push(terminal)
  await new Promise<void>((resolve) =>
    terminal.write(
      '› 请分析技术文档\r\n\r\n• Ran rg files\r\n  diagnostic output\r\n\r\n• 已安排成员分析技术文档。\r\n\r\n› ',
      resolve
    )
  )
  return terminal
}
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose()
})
test('locates a completed turn in the real ANSI terminal buffer without changing it', async () => {
  const terminal = await fixture()
  const before = terminal.buffer.active.getLine(2)?.translateToString()
  expect(findTerminalProcessBounds(terminal.buffer.active, turn)).toEqual({
    promptRow: 0,
    answerRow: 5,
    hiddenRows: 4,
  })
  expect(terminal.buffer.active.getLine(2)?.translateToString()).toBe(before)
})
test('recognizes Chinese prompts and answers across narrow terminal wrapping', async () => {
  const terminal = await fixture(16)
  expect(findTerminalProcessBounds(terminal.buffer.active, turn)?.answerRow).toBeGreaterThan(5)
})
test('does not hide running, interrupted, mismatched or alternate-screen output', async () => {
  const terminal = await fixture()
  for (const status of ['running', 'interrupted'] as const)
    expect(findTerminalProcessBounds(terminal.buffer.active, { ...turn, status })).toBeNull()
  expect(
    findTerminalProcessBounds(terminal.buffer.active, { ...turn, prompt: 'Another task' })
  ).toBeNull()
  expect(
    findTerminalProcessBounds(terminal.buffer.active, { ...turn, answer: 'Unrelated answer' })
  ).toBeNull()
  await new Promise<void>((resolve) => terminal.write('\x1b[?1049h', resolve))
  expect(findTerminalProcessBounds(terminal.buffer.active, turn)).toBeNull()
})

test('does not guess when a tool quotes the same assistant answer', async () => {
  const terminal = await fixture()
  await new Promise<void>((resolve) =>
    terminal.write('\r\n• 已安排成员分析技术文档。\r\n', resolve)
  )
  expect(findTerminalProcessBounds(terminal.buffer.active, turn)).toBeNull()
})
