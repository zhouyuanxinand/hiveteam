import { describe, expect, test } from 'vitest'

import { TerminalStateMirror } from '../../src/server/terminal-state-mirror.js'

describe('TerminalStateMirror', () => {
  test('preserves focus reporting in a restore snapshot', async () => {
    const mirror = new TerminalStateMirror()

    try {
      mirror.write('\x1b[?1004h')

      expect((await mirror.getSnapshot()).endsWith('\x1b[?1004h')).toBe(true)
    } finally {
      mirror.dispose()
    }
  })

  test('preserves SGR mouse encoding in a restore snapshot', async () => {
    const mirror = new TerminalStateMirror()

    try {
      mirror.write('\x1b[?1006h')

      expect((await mirror.getSnapshot()).endsWith('\x1b[?1006h')).toBe(true)
    } finally {
      mirror.dispose()
    }
  })

  test('preserves SGR pixel encoding and clears it on reset', async () => {
    const mirror = new TerminalStateMirror()

    try {
      mirror.write('\x1b[?1016h')
      expect((await mirror.getSnapshot()).endsWith('\x1b[?1016h')).toBe(true)

      mirror.write('\x1bc')
      expect((await mirror.getSnapshot()).endsWith('\x1b[?1016h')).toBe(false)
    } finally {
      mirror.dispose()
    }
  })

  test('coalesced burst writes preserve content order', async () => {
    const mirror = new TerminalStateMirror()

    try {
      for (let index = 0; index < 100; index += 1) mirror.write(`line-${index}\r\n`)
      const snapshot = await mirror.getSnapshot()
      let position = -1
      for (let index = 0; index < 100; index += 1) {
        const next = snapshot.indexOf(`line-${index}`)
        expect(next).toBeGreaterThan(position)
        position = next
      }
    } finally {
      mirror.dispose()
    }
  })

  test('lastPtyLine tracks the latest flushed output', async () => {
    const mirror = new TerminalStateMirror()

    try {
      mirror.write('first\r\nsecond\r\n')
      await mirror.getSnapshot()
      expect(mirror.lastPtyLine()).toBe('second')
      const cached = mirror.lastPtyLine()
      expect(mirror.lastPtyLine()).toBe(cached)

      mirror.write('third\r\n')
      await mirror.getSnapshot()
      expect(mirror.lastPtyLine()).toBe('third')
    } finally {
      mirror.dispose()
    }
  })
})
