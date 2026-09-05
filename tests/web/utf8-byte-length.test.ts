import { describe, expect, test } from 'vitest'

import { utf8ByteLength } from '../../web/src/terminal/utf8.js'

describe('utf8ByteLength', () => {
  test('matches TextEncoder across scripts and symbols', () => {
    const encoder = new TextEncoder()
    const samples = [
      '',
      'plain ascii',
      '中文混合 with 汉字',
      'emoji 😀 and flags 🇨🇳',
      'combining é accents',
      'box drawing ┌─┐│└┘',
      'ansi \x1b[38;2;96;165;250mcolored\x1b[0m',
    ]
    for (const sample of samples) {
      expect(utf8ByteLength(sample), JSON.stringify(sample)).toBe(encoder.encode(sample).byteLength)
    }
  })

  test('matches TextEncoder for lone and split surrogates', () => {
    const encoder = new TextEncoder()
    const samples = [
      '\ud800', // lone high surrogate
      '\udc00', // lone low surrogate
      '\ud800x', // high surrogate followed by ascii
      '\ud800中', // high surrogate followed by a BMP multibyte char
      'x\ud800', // trailing lone high surrogate
      '\ud800\ud800\udc00', // high-high-low sequence
      '😀', // intact pair
    ]
    for (const sample of samples) {
      expect(utf8ByteLength(sample), JSON.stringify(sample)).toBe(encoder.encode(sample).byteLength)
    }
  })

  test('long mixed output chunks stay exact', () => {
    const encoder = new TextEncoder()
    const chunk = 'ok 中 😀\r\n'.repeat(500)
    expect(utf8ByteLength(chunk)).toBe(encoder.encode(chunk).byteLength)
  })
})
