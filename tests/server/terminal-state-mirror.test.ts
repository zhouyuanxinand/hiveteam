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

  test('keeps up with PTY redraws arriving in separate event-loop turns', async () => {
    const mirror = new TerminalStateMirror()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const readAfterBurst = async () => {
        for (let index = 0; index < 6000; index += 1) {
          mirror.write(`\x1b[Hframe-${String(index).padStart(4, '0')}`)
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        mirror.write('\r\n› [Pasted Content 6000 chars]')
        return mirror.getScreenText()
      }
      const screen = await Promise.race([
        readAfterBurst(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('The terminal mirror did not catch up with the PTY redraws')),
            2000
          )
        }),
      ])
      expect(screen.trim()).toBe('frame-5999\n› [Pasted Content 6000 chars]')
    } finally {
      if (timeout) clearTimeout(timeout)
      mirror.dispose()
    }
  })

  test('seals pending output at screen, snapshot and resize boundaries', async () => {
    const mirror = new TerminalStateMirror({ cols: 10, rows: 3 })
    const restored = new TerminalStateMirror({ cols: 10, rows: 3 })
    try {
      mirror.write('\x1b[?1049h\x1b[HABCDEFGHIJ')
      // Let the first native parser write start without waiting for it to
      // finish, then queue further writes and observation boundaries.
      await new Promise<void>((resolve) => setImmediate(resolve))
      mirror.write('\x1b[2;1HBEFORE')
      const beforeScreen = mirror.getScreenText()
      const beforeSnapshot = mirror.getSnapshot()
      mirror.resize(5, 4)
      mirror.write('\x1b[2J\x1b[H12345X\x1b[2;1HZ')
      const afterScreen = mirror.getScreenText()
      mirror.write('\x1b[2J\x1b[HAFTER')

      expect((await beforeScreen).trim()).toBe('ABCDEFGHIJ\nBEFORE')
      restored.write(await beforeSnapshot)
      expect((await restored.getScreenText()).trim()).toBe('ABCDEFGHIJ\nBEFORE')
      expect((await afterScreen).trim()).toBe('12345Z')
      expect((await mirror.getScreenText()).trim()).toBe('AFTER')
    } finally {
      mirror.dispose()
      restored.dispose()
    }
  })
})
