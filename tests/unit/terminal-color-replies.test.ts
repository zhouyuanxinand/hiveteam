import { afterEach, expect, test, vi } from 'vitest'
import { createCodexColorReplyBroker } from '../../src/server/terminal-color-replies.js'

const query = '\u001b]10;?\u001b\\\u001b]11;?\u0007'
const fg = '\u001b]10;rgb:eeee/eeee/eeee\u001b\\'
const bg = '\u001b]11;rgb:1111/1111/1111\u0007'
afterEach(() => vi.useRealTimers())

test('allows only the first response to each live foreground/background query', () => {
  const broker = createCodexColorReplyBroker()
  expect(broker.filter(fg + bg)).toBe('')
  broker.observeOutput(query)
  expect(broker.filter(fg + bg)).toBe(fg + bg)
  expect(broker.filter(fg + bg)).toBe('')
  broker.observeOutput(query)
  expect(broker.filter(bg + fg)).toBe(bg + fg)
})

test('tracks a query split across output frames without rearming a completed query', () => {
  const broker = createCodexColorReplyBroker()
  broker.observeOutput('\u001b]10;?\u001b')
  broker.observeOutput('\\')
  expect(broker.filter(fg)).toBe(fg)
  broker.observeOutput('another repaint')
  expect(broker.filter(fg)).toBe('')
})

test('drops expired replies before the native probe returns input to the composer', () => {
  vi.useFakeTimers()
  const broker = createCodexColorReplyBroker()
  broker.observeOutput(query)
  vi.advanceTimersByTime(200)
  expect(broker.filter(fg + bg)).toBe('')
  broker.observeOutput(query)
  expect(broker.filter(fg + bg)).toBe(fg + bg)
})

test('preserves unrelated replies, user text, pastes and binary bytes', () => {
  const broker = createCodexColorReplyBroker()
  expect(broker.filter(`\u001b[I${fg}\u001b[1;1R`)).toBe('\u001b[I\u001b[1;1R')
  for (const input of ['ordinary input\r', `${fg}literal draft`, `\u001b[200~${fg}\u001b[201~`])
    expect(broker.filter(input)).toBe(input)
  const binary = Buffer.from([27, 91, 77, 255, 140, 180])
  expect(broker.filter(binary)).toEqual(binary)
  broker.observeOutput(query)
  expect(broker.filter(Buffer.from(fg))).toEqual(Buffer.from(fg))
  expect(broker.filter(Buffer.from(fg))).toEqual(Buffer.alloc(0))
})
