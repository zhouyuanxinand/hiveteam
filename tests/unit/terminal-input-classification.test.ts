import headlessTerminalModule from '@xterm/headless'
import { describe, expect, test } from 'vitest'
import { isTerminalReplyOnly } from '../../src/server/terminal-input-classification.js'

const { Terminal } = headlessTerminalModule as typeof import('@xterm/headless')

describe('terminal input classification', () => {
  test.each([
    ['cursor position', '\x1b[6n'],
    ['DEC cursor position', '\x1b[?6n'],
    ['device attributes', '\x1b[c'],
    ['secondary device attributes', '\x1b[>c'],
    ['device status', '\x1b[5n'],
    ['DEC mode', '\x1b[?2026$p'],
    ['ANSI mode', '\x1b[4$p'],
    ['window character size', '\x1b[18t'],
    ['graphic rendition', '\x1bP$qm\x1b\\'],
    ['scroll margins', '\x1bP$qr\x1b\\'],
    ['cursor style', '\x1bP$q q\x1b\\'],
    ['protection', '\x1bP$q"q\x1b\\'],
    ['conformance', '\x1bP$q"p\x1b\\'],
    ['unrecognized status request', '\x1bP$qunknown\x1b\\'],
  ])('recognizes the actual xterm response for %s', async (_name, query) => {
    const terminal = new Terminal({
      allowProposedApi: true,
      windowOptions: { getWinSizeChars: true },
    })
    const replies: string[] = []
    terminal.onData((data) => replies.push(data))
    try {
      await new Promise<void>((resolve) => terminal.write(query, resolve))
      expect(replies.length).toBeGreaterThan(0)
      for (const reply of replies) expect(isTerminalReplyOnly(reply)).toBe(true)
      expect(isTerminalReplyOnly(replies.join(''))).toBe(true)
    } finally {
      terminal.dispose()
    }
  })

  test.each([
    '\x1b[I',
    '\x1b[O',
    '\x1b[4;900;1200t',
    '\x1b[6;18;9t',
    '\x1b]10;rgb:dddd/dddd/dddd\x1b\\',
    '\x1b]11;rgb:1111/2222/3333\x07',
    '\x1b]12;rgb:f/ff/ffff\x1b\\',
    '\x1b]4;255;rgb:0000/8888/ffff\x1b\\',
    '\x1b[I\x1b[?2026;2$y\x1b]11;rgb:0000/0000/0000\x07\x1b[O',
  ])('recognizes browser-only or combined replies %j', (reply) => {
    expect(isTerminalReplyOnly(reply)).toBe(true)
  })

  test.each([
    '',
    'user draft',
    '\r',
    '\n',
    '\x1b[C',
    '\x1b[13;2u',
    '\x1b[<0;3;4M',
    '\x1b[M !!',
    '\x1b[200~draft\x1b[201~',
    '\x1b[Iuser draft',
    'user draft\x1b[I',
    '\x1b[I\n',
    '\x1b[I\r\n',
    '\x1b[I\u2028',
    '\x1b[I\x1b[C',
    '\x1b[?2026;9$y',
    '\x1b[?2026;2$y\n',
    '\x1b[99;900;1200t',
    '\x1b]11;user draft\x07',
    '\x1b]4;256;rgb:0000/0000/0000\x07',
    '\x1b]11;rgb:00\n00/0000/0000\x07',
    '\x1b]11;rgb:0000/0000/0000\x07\n',
    '\x1b]11;rgb:0000/0000/0000',
    '\x1b]52;c;cHJpdmF0ZQ==\x07',
    '\x1bP1$ruser draft\x1b\\',
    '\x1bP1$r0m\x1b\\\r',
    '\x1bPunknown\x1b\\',
    '\x1b[?1;',
    '\x1b[?999x',
  ])('keeps edits, mixed input and unknown sequences as input %j', (input) => {
    expect(isTerminalReplyOnly(input)).toBe(false)
  })
})
