import { describe, expect, test } from 'vitest'

import { TerminalStateMirror } from '../../src/server/terminal-state-mirror.js'

describe('TerminalStateMirror', () => {
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
})
