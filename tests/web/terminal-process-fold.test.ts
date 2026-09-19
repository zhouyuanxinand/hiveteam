// @vitest-environment jsdom

import { fireEvent, within } from '@testing-library/dom'
import { Terminal } from '@xterm/xterm'
import { afterEach, expect, test, vi } from 'vitest'
import { createTerminalProcessFold } from '../../web/src/terminal/terminal-process-fold.js'

const disposables: Array<() => void> = []
const labels = { history: '终端消息', internalCall: '内部调用', lines: '{count} 行' }
const transcript =
  '› 请分析技术文档\r\n\r\n• 我先查看当前可用的成员。\r\n\r\n• Ran Get-ChildItem -Force\r\n  Directory: D:\\项目\r\n  result.txt\r\n\r\n› '

const fixture = async () => {
  const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
  disposables.push(() => terminal.dispose())
  const container = document.createElement('div')
  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  element.append(screen)
  container.append(element)
  document.body.append(container)
  // The ANSI parser, buffer and cursor are real. Only layout is supplied for jsdom.
  Object.defineProperty(terminal, 'element', { value: element })
  Object.defineProperty(screen, 'clientHeight', { value: 480 })
  const write = (text: string) => new Promise<void>((resolve) => terminal.write(text, resolve))
  await write(transcript)
  const fold = createTerminalProcessFold(terminal, container)
  disposables.push(() => fold.dispose())
  fold.setLabels(labels)
  fold.afterOutput()
  return { terminal, container, fold, write }
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  for (const dispose of disposables.splice(0).reverse()) dispose()
  document.body.replaceChildren()
  vi.useRealTimers()
})

test('folds internal calls before a running turn has produced its final answer', async () => {
  const { container, terminal } = await fixture()
  const history = within(container).getByRole('region', { name: '终端消息' })
  expect(within(history).getByText('内部调用')).toBeVisible()
  expect(within(history).getByText(/Ran Get-ChildItem/)).not.toBeVisible()
  expect(within(history).getByText('• 我先查看当前可用的成员。')).toBeVisible()
  expect(within(history).getByText('› 请分析技术文档')).toBeVisible()
  expect(history.querySelector('details')?.open).toBe(false)
  expect(terminal.buffer.active.getLine(4)?.translateToString(true)).toContain('Get-ChildItem')
  expect(terminal.buffer.active.getLine(8)?.translateToString(true)).toBe('› ')
})

test('reveals original commands on demand and preserves the choice across streamed output', async () => {
  const { container, fold, write } = await fixture()
  const disclosure = container.querySelector('details')
  if (!disclosure) throw new Error('Missing internal-call disclosure')
  disclosure.open = true
  expect(within(disclosure).getByText(/Ran Get-ChildItem/)).toBeVisible()
  await write('\x1b[1G\x1b[2K• Ran hive --help\r\n  Usage: hive\r\n› ')
  fold.afterOutput()
  expect(container.querySelectorAll('details')).toHaveLength(2)
  expect(container.querySelector('details')).toBe(disclosure)
  expect(disclosure.open).toBe(true)
  expect(container.querySelectorAll('details')[1]?.open).toBe(false)
  expect(within(container).getByText(/Ran hive --help/)).not.toBeVisible()
})

test('typing and scrolling do not expand internal calls', async () => {
  const { container } = await fixture()
  fireEvent.keyDown(container, { key: 'a' })
  fireEvent.compositionStart(container, { data: '中' })
  fireEvent.wheel(within(container).getByRole('region'), { deltaY: -100 })
  expect(container.querySelector('details')?.open).toBe(false)
  expect(within(container).getByText(/Ran Get-ChildItem/)).not.toBeVisible()
})

test('native confirmations are exposed without deleting retained history', async () => {
  const { container, terminal, fold, write } = await fixture()
  await write('\x1b[1G\x1b[2KWould you like to run this command?\r\n1. Yes')
  fold.afterOutput()
  expect(within(container).queryByRole('region')).toBeNull()
  expect(container).not.toHaveAttribute('data-process-collapsed')
  expect(terminal.buffer.active.getLine(8)?.translateToString(true)).toContain('Would you like')
  expect(terminal.buffer.active.getLine(4)?.translateToString(true)).toContain('Get-ChildItem')
})

test('shell terminals remain native until explicitly enabled for an agent', async () => {
  const { container, fold } = await fixture()
  fold.setLabels(undefined)
  fold.afterOutput()
  expect(within(container).queryByRole('region')).toBeNull()
  expect(container).not.toHaveAttribute('data-process-collapsed')
})

test('keeps selected text intact while output arrives and never interprets output as HTML', async () => {
  const { container, fold, write } = await fixture()
  const message = within(container).getByText('• 我先查看当前可用的成员。')
  const range = document.createRange()
  range.selectNodeContents(message)
  document.getSelection()?.addRange(range)
  await write('\x1b[1G\x1b[2K• <img src=x onerror=alert(1)>\r\n› ')
  fold.afterOutput()
  expect(document.getSelection()?.toString()).toBe('• 我先查看当前可用的成员。')
  document.getSelection()?.removeAllRanges()
  fold.afterOutput()
  expect(within(container).getByText('• <img src=x onerror=alert(1)>')).toBeVisible()
  expect(container.querySelector('img')).toBeNull()
})
