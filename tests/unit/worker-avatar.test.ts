import { describe, expect, test } from 'vitest'

import { normalizeWorkerAvatar, WORKER_AVATAR_MAX_CHARS } from '../../src/shared/worker-avatar.js'

const PNG_AVATAR =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Jr0YAAAAASUVORK5CYII='

describe('worker avatar validation', () => {
  test('accepts a compact PNG data URL and removes surrounding whitespace', () => {
    expect(normalizeWorkerAvatar(`  ${PNG_AVATAR}  `)).toBe(PNG_AVATAR)
  })

  test('treats an empty or cleared field as no custom avatar', () => {
    expect(normalizeWorkerAvatar(null)).toBeNull()
    expect(normalizeWorkerAvatar(undefined)).toBeNull()
    expect(normalizeWorkerAvatar('  ')).toBeNull()
  })

  test('rejects executable or mismatched image payloads', () => {
    expect(() => normalizeWorkerAvatar('data:image/svg+xml;base64,PHN2Zy8+')).toThrow(
      'Avatar must be a PNG, JPEG, or WebP image.'
    )
    expect(() => normalizeWorkerAvatar(PNG_AVATAR.replace('image/png', 'image/jpeg'))).toThrow(
      'Avatar image data is invalid.'
    )
  })

  test('rejects oversized payloads before decoding them', () => {
    const oversized = `data:image/png;base64,${'A'.repeat(WORKER_AVATAR_MAX_CHARS)}`
    expect(() => normalizeWorkerAvatar(oversized)).toThrow('Avatar is too large')
  })
})
