import { Terminal } from '@xterm/headless'
import { afterEach, expect, test } from 'vitest'
import { readTerminalProcessHistory } from '../../web/src/terminal/terminal-process-bounds.js'

const terminals: Terminal[] = []
const transcript =
  '› 请分析技术文档\r\n\r\n• 我先查看成员。\r\n\r\n• Ran Get-ChildItem -Force\r\n  └ Directory: D:\\项目\r\n    result.txt\r\n\r\n• 成员已找到，继续分析。\r\n\r\n• Ran hive --help\r\n  └ Usage: hive\r\n\r\n› '
const fixture = async (output = transcript, cols = 100) => {
  const terminal = new Terminal({ cols, rows: 36, allowProposedApi: true })
  terminals.push(terminal)
  await new Promise<void>((resolve) => terminal.write(output, resolve))
  return terminal
}
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose()
})

test('separates live internal commands from user messages and intermediate replies', async () => {
  const terminal = await fixture()
  const model = readTerminalProcessHistory(terminal.buffer.active)
  expect(model?.blocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
    { kind: 'prompt', text: '› 请分析技术文档' },
    { kind: 'message', text: '• 我先查看成员。' },
    { kind: 'tool', text: '• Ran Get-ChildItem -Force\n  └ Directory: D:\\项目\n    result.txt' },
    { kind: 'message', text: '• 成员已找到，继续分析。' },
    { kind: 'tool', text: '• Ran hive --help\n  └ Usage: hive' },
  ])
  expect(model?.composerRow).toBe(13)
  expect(terminal.buffer.active.getLine(4)?.translateToString(true)).toBe(
    '• Ran Get-ChildItem -Force'
  )
})

test('joins narrow Chinese and ANSI-wrapped commands without losing their text', async () => {
  const terminal = await fixture(
    transcript.replace('Get-ChildItem', '\x1b[32mGet-ChildItem\x1b[0m'),
    18
  )
  const model = readTerminalProcessHistory(terminal.buffer.active)
  expect(model?.blocks.filter(({ kind }) => kind === 'tool').map(({ text }) => text)).toEqual([
    '• Ran Get-ChildItem -Force\n  └ Directory: D:\\项目\n    result.txt',
    '• Ran hive --help\n  └ Usage: hive',
  ])
})

test('keeps final answers, interruptions and later user prompts outside tool output', async () => {
  const terminal = await fixture(
    transcript.replace(
      /› $/,
      '• 文档已分析完成。\r\n■ Conversation interrupted\r\n› 新的问题\r\n• Ran team list\r\n  └ one member\r\n› '
    )
  )
  const blocks = readTerminalProcessHistory(terminal.buffer.active)?.blocks ?? []
  expect(blocks.filter(({ kind }) => kind !== 'tool').map(({ text }) => text)).toContain(
    '• 文档已分析完成。'
  )
  expect(blocks.filter(({ kind }) => kind !== 'tool').map(({ text }) => text)).toContain(
    '■ Conversation interrupted'
  )
  expect(blocks.filter(({ kind }) => kind === 'prompt').map(({ text }) => text)).toContain(
    '› 新的问题'
  )
  expect(blocks.filter(({ kind }) => kind === 'tool')).toHaveLength(3)
})

test('leaves native approval and session-lock screens unchanged', async () => {
  for (const prompt of [
    'Would you like to run this command?\r\n1. Yes',
    'This conversation is open in another app\r\nr retry',
  ]) {
    const terminal = await fixture(transcript.replace(/› $/, prompt))
    expect(readTerminalProcessHistory(terminal.buffer.active)).toBeNull()
  }
})

test('does not reinterpret shells, full-screen TUIs or ordinary assistant text', async () => {
  const shell = await fixture('PS D:\\项目> Get-ChildItem\r\nfile.txt\r\nPS D:\\项目> ')
  expect(readTerminalProcessHistory(shell.buffer.active)).toBeNull()
  const noTools = await fixture('› Question\r\n• Here is your answer.\r\n› ')
  expect(readTerminalProcessHistory(noTools.buffer.active)).toBeNull()
  const terminal = await fixture()
  await new Promise<void>((resolve) => terminal.write('\x1b[?1049h', resolve))
  expect(readTerminalProcessHistory(terminal.buffer.active)).toBeNull()
})

test('keeps multiline active input out of the read-only history', async () => {
  const terminal = await fixture(`${transcript}这是一个很长的中文输入，还没有发送给模型`, 18)
  const model = readTerminalProcessHistory(terminal.buffer.active)
  expect(model?.blocks.some(({ text }) => text.includes('还没有发送'))).toBe(false)
  expect(model?.blocks.filter(({ kind }) => kind === 'tool')).toHaveLength(2)
})

test('recognizes Codex Ultra prompts without absorbing an active draft', async () => {
  const terminal = await fixture(`${transcript.replaceAll('›', '»')}尚未提交的中文输入`, 18)
  const result = readTerminalProcessHistory(terminal.buffer.active)
  expect(result?.blocks.filter((block) => block.kind === 'tool')).toHaveLength(2)
  expect(result?.blocks.some((block) => block.text.includes('尚未提交'))).toBe(false)
  expect(result?.blocks[0]?.text).toBe('» 请分析技术文档')
})
