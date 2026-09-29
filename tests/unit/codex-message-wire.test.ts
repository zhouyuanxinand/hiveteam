import { expect, test } from 'vitest'
import {
  codexMessageHash,
  codexReceiptHash,
  completeCodexEncodedPasteVisible,
  encodeCodexMessage,
} from '../../src/server/codex-message-wire.js'
import type { ReportDeliveryCheckpoint } from '../../src/server/report-delivery-receipt.js'

test('encodes the complete message as one lossless JSON line', () => {
  const text = '中文 🐝\n\n  保留缩进和  双空格\r\n"引号"\\路径\t制表符\u2028换行\u2029段落\n'
  const wire = encodeCodexMessage(text)
  expect(wire).not.toMatch(/[\r\n\u2028\u2029]/u)
  expect(JSON.parse(wire.slice(wire.indexOf(': ') + 2))).toBe(text)
  expect(codexMessageHash(wire)).not.toBe(codexMessageHash(text))
})

test('matches an actual native composer with an inline prefix and a paste chip', () => {
  const wire = encodeCodexMessage('原生正文\n'.repeat(800))
  const points = Array.from(wire)
  const content = `› ${points.slice(0, 80).join('')}[Pasted Content ${points.length - 80} chars]\n\n  tab to queue message`
  expect(completeCodexEncodedPasteVisible(content, wire)).toBe(true)
  expect(completeCodexEncodedPasteVisible(content, `${wire}!`)).toBe(false)
})

test('matches multiple chips and visual wraps in sequence, preserving Unicode and spaces', () => {
  const wire = 'ASCII 中文 🐝  visible tail'
  const content =
    '› ASCII [Pasted Content 3 chars]\n  🐝  visible [Pasted Content 4 chars]\n\n  footer'
  expect(completeCodexEncodedPasteVisible(content, wire)).toBe(true)
  expect(completeCodexEncodedPasteVisible(content.replace('🐝  visible', '🐝 visible'), wire)).toBe(
    false
  )
  expect(completeCodexEncodedPasteVisible(content.replace('ASCII', 'ASXII'), wire)).toBe(false)
  expect(completeCodexEncodedPasteVisible(content.replace('visible', 'changed'), wire)).toBe(false)
})

test('recognizes a paste chip label that Codex itself wraps across composer rows', () => {
  const wire = `visible ${'x'.repeat(2686)}${'y'.repeat(1513)}`
  const content = '› visible [Pasted Content 2686 chars][Pasted Content 1513\n  chars]\n\n  footer'
  expect(completeCodexEncodedPasteVisible(content, wire)).toBe(true)
  expect(completeCodexEncodedPasteVisible(content.replace('2686', '2685'), wire)).toBe(false)
})

test.each([
  '› [Pasted Content 4 chars]',
  '› [Pasted Content 6 chars]',
  '› [Pasted Content 0 chars]',
  '› [Pasted Content 99999999999999999999 chars]',
  '› [Pasted Content 5 chars]extra',
  '› [Pasted Content 5 chars]\n  extra draft',
  '› ab\n cde',
  '› ab\n  wrong',
  '  continuation without the composer',
])('rejects incomplete, changed or unproven composer content: %j', (content) => {
  expect(completeCodexEncodedPasteVisible(content, 'abcde')).toBe(false)
})

test('does not remove body whitespace or treat a literal chip label as an opaque paste', () => {
  const text = '  exactly  [Pasted Content 12 chars]  '
  expect(completeCodexEncodedPasteVisible(`› ${text}`, text)).toBe(true)
  expect(completeCodexEncodedPasteVisible(`› ${text.trim()}`, text)).toBe(false)
  expect(completeCodexEncodedPasteVisible('› first\n  second', 'first\nsecond')).toBe(false)
})

const checkpoint: ReportDeliveryCheckpoint = {
  cwd: '/workspace',
  inputSequence: 1,
  lastSubmitAt: 0,
  offset: 0,
  pasteConfirmed: false,
  runId: 'run',
  sessionFile: null,
  sessionId: null,
  submitAttempts: 0,
}
test('retains legacy checkpoint semantics and requires a valid digest for the new wire format', () => {
  expect(codexReceiptHash(checkpoint)).toBeUndefined()
  const digest = codexMessageHash('complete wire')
  expect(
    codexReceiptHash({ ...checkpoint, wireFormat: 'json-string-v1', wireSha256: digest })
  ).toBe(digest)
  expect(() => codexReceiptHash({ ...checkpoint, wireFormat: 'json-string-v1' })).toThrow(
    'invalid wire format'
  )
  expect(() => codexReceiptHash({ ...checkpoint, wireSha256: digest })).toThrow(
    'invalid wire format'
  )
  expect(() =>
    codexReceiptHash({ ...checkpoint, wireFormat: 'json-string-v1', wireSha256: 'bad' })
  ).toThrow('invalid wire format')
})
