import { expect, test } from 'vitest'
import { hasCodexOwnershipPrompt } from '../../src/server/terminal-session-recovery.js'
import { TerminalStateMirror } from '../../src/server/terminal-state-mirror.js'

const prompt = [
  '\x1b[1mThis conversation is open in another app\x1b[0m   R to Retry',
  'Close it there and press R to continue here.',
  '',
  'r retry    esc/ctrl+c/q exit    ctrl+t transcript',
].join('\r\n')

test.each([
  20, 21, 25, 38, 39, 40, 42, 43, 44, 45, 46, 63, 80, 132,
])('recognizes a repainted native prompt at %i columns', async (cols) => {
  const mirror = new TerminalStateMirror({ cols, rows: 24 })
  try {
    mirror.write('Previous task output\r\n\x1b[2J\x1b[H')
    for (const chunk of [prompt.slice(0, 18), prompt.slice(18, 55), prompt.slice(55)])
      mirror.write(chunk)
    expect(hasCodexOwnershipPrompt(await mirror.getScreenText())).toBe(true)
    mirror.write('\x1b[2J\x1b[H› Ask Codex to do anything')
    expect(hasCodexOwnershipPrompt(await mirror.getScreenText())).toBe(false)
  } finally {
    mirror.dispose()
  }
})

test('does not detect a quoted prompt above a normal composer', async () => {
  const mirror = new TerminalStateMirror()
  try {
    mirror.write(`${prompt}\r\n› Explain this error`)
    expect(hasCodexOwnershipPrompt(await mirror.getScreenText())).toBe(false)
  } finally {
    mirror.dispose()
  }
})
