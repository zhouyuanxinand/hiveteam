// @vitest-environment jsdom
import { within } from '@testing-library/react'
import { Terminal } from '@xterm/xterm'
import { afterEach, expect, test } from 'vitest'
import type { AgentConversation, ConversationTurn } from '../../src/shared/agent-conversation.js'
import { createTerminalProcessFold } from '../../web/src/terminal/terminal-process-fold.js'

const labels = {
  history: '终端消息',
  internalCall: '内部调用',
  lines: '{count} 行',
  process: '执行过程',
  running: '正在执行…',
  interrupted: '本轮执行已中断。',
  truncated: '部分记录已省略。',
}
const dispose: Array<() => void> = []
afterEach(() => {
  document.getSelection()?.removeAllRanges()
  for (const close of dispose.splice(0).reverse()) close()
  document.body.replaceChildren()
})
const turn = (status: ConversationTurn['status'] = 'running'): ConversationTurn => ({
  id: 'first',
  prompt: '分析技术文档',
  status,
  process: [
    { id: 'comment', kind: 'commentary', text: '先提取正文，再核对接口。' },
    { id: 'call', kind: 'tool', text: 'exec_command\nGet-Content document.xml\n正文与规则' },
  ],
  answer: status === 'complete' ? '结论第一段：需要确认接口。\n\n结论第二段：建议分阶段实施。' : '',
})
const conversation = (turns: ConversationTurn[]): AgentConversation => ({
  run_id: 'current-run',
  status: 'ready',
  session_id: 'bound-session',
  turns,
  truncated: false,
})
const fixture = async (
  transcript = '» 分析技术文档\r\n• 原生说明\r\n• Ran native-command\r\n  原始输出\r\n» '
) => {
  const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
  dispose.push(() => terminal.dispose())
  const container = document.createElement('div')
  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  element.append(screen)
  container.append(element)
  document.body.append(container)
  Object.defineProperty(terminal, 'element', { value: element })
  Object.defineProperty(screen, 'clientHeight', { value: 480 })
  const write = (text: string) => new Promise<void>((resolve) => terminal.write(text, resolve))
  await write(transcript)
  const fold = createTerminalProcessFold(terminal, container, 'current-run')
  dispose.push(() => fold.dispose())
  fold.setLabels(labels)
  const show = (data: AgentConversation | undefined) => {
    fold.setConversation(data)
    fold.afterOutput()
  }
  return { terminal, container, write, fold, show }
}

test('a confirmed final answer folds commentary and calls together while retaining the entire answer and native bytes', async () => {
  const { container, show, terminal } = await fixture()
  show(conversation([turn()]))
  const history = within(container).getByRole('region', { name: '终端消息' })
  expect(within(history).getByText('正在执行…')).toBeVisible()
  expect(history.querySelector('details')?.open).toBe(true)
  expect(within(history).getByText(/先提取正文/)).toBeVisible()
  show(conversation([turn('complete')]))
  expect(history.querySelector('details')?.open).toBe(false)
  expect(within(history).getByText(/先提取正文/)).not.toBeVisible()
  expect(within(history).getByText(/结论第一段/)).toBeVisible()
  expect(within(history).getByText(/结论第一段/).textContent).toBe(turn('complete').answer)
  expect(within(history).getByText('分析技术文档')).toBeVisible()
  const disclosure = history.querySelector('details')
  if (!disclosure) throw new Error('Missing process disclosure')
  disclosure.open = true
  expect(within(history).getByText(/Get-Content document.xml/)).toBeVisible()
  expect(terminal.buffer.active.getLine(2)?.translateToString(true)).toBe('• Ran native-command')
  expect(terminal.buffer.active.getLine(4)?.translateToString(true)).toBe('» ')
})

test('manual disclosure choices survive polling and only the newly completed turn auto-collapses', async () => {
  const { container, show, fold } = await fixture()
  show(conversation([turn('complete')]))
  const first = container.querySelector('details')
  if (!first) throw new Error('Missing first process disclosure')
  first.open = true
  show(conversation([turn('complete')]))
  fold.resize()
  fold.afterOutput()
  expect(container.querySelector('details')).toBe(first)
  expect(first.open).toBe(true)
  const second: ConversationTurn = { ...turn(), id: 'second', prompt: '继续分析' }
  show(conversation([turn('complete'), second]))
  expect(container.querySelectorAll('details')[1]?.open).toBe(true)
  show(conversation([turn('complete'), { ...second, status: 'complete', answer: '第二轮结论' }]))
  expect(first.open).toBe(true)
  expect(container.querySelectorAll('details')[1]?.open).toBe(false)
  expect(within(container).getByText('第二轮结论')).toBeVisible()
  expect(within(container).getByText(/结论第一段/)).toBeVisible()
})

test('reasoning summaries without tools also fold after completion, but private reasoning is not invented', async () => {
  const { container, show } = await fixture('› 问题\r\n• 原生答复\r\n› ')
  show(
    conversation([
      {
        ...turn('complete'),
        process: [{ id: 'visible', kind: 'commentary', text: '公开的进度说明' }],
      },
    ])
  )
  expect(within(container).getByText('执行过程')).toBeVisible()
  expect(within(container).getByText('公开的进度说明')).not.toBeVisible()
  expect(within(container).getByText(/结论第二段/)).toBeVisible()
})

test('a foreign run, pending response or failed read cannot project a stale conclusion', async () => {
  const { container, show } = await fixture()
  for (const data of [
    { ...conversation([turn('complete')]), run_id: 'previous-run' },
    { ...conversation([turn('complete')]), status: 'pending' as const },
    undefined,
  ]) {
    show(data)
    expect(within(container).queryByText(/结论第一段/)).toBeNull()
    expect(within(container).getByText('• 原生说明')).toBeVisible()
  }
})

test('native approvals and the raw-terminal switch always expose the original PTY', async () => {
  const { container, show, fold, write, terminal } = await fixture()
  show(conversation([turn('complete')]))
  fold.setLabels(undefined)
  expect(within(container).queryByRole('region')).toBeNull()
  expect(container).not.toHaveAttribute('data-process-collapsed')
  fold.setLabels(labels)
  await write('\x1b[1G\x1b[2KWould you like to run this command?\r\n1. Yes')
  fold.afterOutput()
  expect(within(container).queryByRole('region')).toBeNull()
  expect(terminal.buffer.active.getLine(4)?.translateToString(true)).toContain('Would you like')
})

test('interruption and bounded history are visible, and process output remains text', async () => {
  const { container, show } = await fixture()
  show({
    ...conversation([
      {
        ...turn('interrupted'),
        truncated: true,
        process: [
          { id: 'tool', kind: 'tool', text: '<script>untrusted()</script>', truncated: true },
        ],
      },
    ]),
    truncated: true,
  })
  expect(within(container).getByText('本轮执行已中断。')).toBeVisible()
  expect(container.querySelector('details')?.open).toBe(true)
  expect(container.textContent).toContain('部分记录已省略。')
  expect(container.querySelector('script')).toBeNull()
  expect(within(container).getByText(/<script>/)).toBeVisible()
})
