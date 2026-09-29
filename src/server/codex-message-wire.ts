import { createHash } from 'node:crypto'
import type { ReportDeliveryCheckpoint } from './report-delivery-receipt.js'

const JSON_MESSAGE_PREFIX =
  'Hive message encoded as a JSON string; interpret escapes as the original message: '

export const encodeCodexMessage = (text: string) =>
  JSON_MESSAGE_PREFIX +
  JSON.stringify(text)
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')

export const codexMessageHash = (text: string) => createHash('sha256').update(text).digest('hex')

/** Old uncertain pastes retain their original transport across upgrades. */
export const codexReceiptHash = (checkpoint: ReportDeliveryCheckpoint): string | undefined => {
  if (checkpoint.wireFormat === undefined && checkpoint.wireSha256 === undefined) return undefined
  if (
    (checkpoint.wireFormat !== 'json-string-v1' && checkpoint.wireFormat !== 'native-initial-v1') ||
    !checkpoint.wireSha256 ||
    !/^[a-f\d]{64}$/u.test(checkpoint.wireSha256)
  )
    throw new Error('Codex delivery checkpoint has an invalid wire format or receipt digest.')
  return checkpoint.wireSha256
}

/** Codex can mix inline text and multiple opaque paste chips. Match each
 * visible character and skip only the exact Unicode length of each chip.
 * A clipped composer, changed character or missing space is not complete. */
export const completeCodexEncodedPasteVisible = (content: string, wire: string) => {
  if (/[\r\n]/u.test(wire)) return false
  const lines = content.split('\n')
  const first = lines[0]?.match(/^[ \t]*› (.*)$/u)
  if (!first) return false
  let display = first[1] ?? ''
  for (let row = 1; row < lines.length; row++) {
    const continuation = lines[row]
    if (!continuation?.trim()) break
    // These two columns belong to the composer renderer, not its text.
    if (!continuation.startsWith('  ')) return false
    display += continuation.slice(2)
  }
  const expected = Array.from(wire)
  let offset = 0
  const consume = () => {
    let cursor = 0
    // A paste chip's own label can wrap across rows. Codex drops the label's
    // separator space at that wrap; tolerate this only inside known UI syntax.
    for (const match of display.matchAll(/\[Pasted[ \t]*Content[ \t]*([\d,]+)[ \t]*chars\]/gu)) {
      const inline = Array.from(display.slice(cursor, match.index))
      if (inline.some((character, index) => character !== expected[offset + index])) return false
      offset += inline.length
      const literal = Array.from(match[0])
      if (literal.every((character, index) => character === expected[offset + index])) {
        offset += literal.length
        cursor = match.index + match[0].length
        continue
      }
      const count = Number(match[1]?.replaceAll(',', ''))
      if (!Number.isSafeInteger(count) || count <= 0 || offset + count > expected.length)
        return false
      offset += count
      cursor = match.index + match[0].length
    }
    const tail = Array.from(display.slice(cursor))
    if (tail.some((character, index) => character !== expected[offset + index])) return false
    offset += tail.length
    return true
  }
  return consume() && offset === expected.length
}
