// Only known non-editing replies emitted by xterm are accepted. Keep each
// reply's grammar narrow: other escape sequences include cursor edits and
// keyboard shortcuts, and OSC/DCS bodies must never absorb arbitrary text.
const TERMINAL_REPLY = new RegExp(
  [
    // Focus, cursor position and device attributes.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol control bytes.
    /\x1b\[[IO]/u,
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol control bytes.
    /\x1b\[\??\d+;\d+R/u,
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol control bytes.
    /\x1b\[[?>]?[\d;]*c/u,
    // Device status, ANSI/DEC mode status, and window/cell/character dimensions.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol control bytes.
    /\x1b\[0n/u,
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol control bytes.
    /\x1b\[\??\d+;[0-4]\$y/u,
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol control bytes.
    /\x1b\[(?:4|6|8);\d+;\d+t/u,
    // Foreground/background/cursor and the 256 palette colors (OSC 4).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol control bytes.
    /\x1b\](?:1[012]|4;(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d));rgb:[\da-fA-F]{1,4}\/[\da-fA-F]{1,4}\/[\da-fA-F]{1,4}(?:\x07|\x1b\\)/u,
    // DECRQSS: rejected request, SGR, scroll margins, cursor style,
    // protection, or conformance. These are xterm's supported status strings.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol control bytes.
    /\x1bP(?:0\$r|1\$r(?:0m|\d+;\d+r|[1-6] q|[01]"q|61;1"p))\x1b\\/u,
  ]
    .map((pattern) => pattern.source)
    .join('|'),
  'uy'
)

export const isTerminalReplyOnly = (input: string): boolean => {
  let offset = 0
  while (offset < input.length) {
    TERMINAL_REPLY.lastIndex = offset
    if (!TERMINAL_REPLY.test(input)) return false
    offset = TERMINAL_REPLY.lastIndex
  }
  // Consume the entire chunk. A regex `$` anchor alone also accepts a match
  // before a final newline, which would hide an actual edit from ownership.
  return offset > 0
}
