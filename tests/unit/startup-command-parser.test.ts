import { describe, expect, test } from 'vitest'

import {
  getStartupCommandExecutable,
  normalizeExecutableToken,
} from '../../src/server/startup-command-parser.js'

describe('startup command parser', () => {
  test('reads a quoted Windows executable path containing spaces', () => {
    expect(getStartupCommandExecutable('"C:\\Program Files\\Zcode\\zcode.cmd" --model glm-5')).toBe(
      'C:\\Program Files\\Zcode\\zcode.cmd'
    )
  })

  test('normalizes executable paths to command preset ids', () => {
    expect(normalizeExecutableToken('C:\\Program Files\\Zcode\\zcode.CMD')).toBe('zcode')
    expect(normalizeExecutableToken('/usr/local/bin/codex')).toBe('codex')
    expect(normalizeExecutableToken('kimi.exe')).toBe('kimi')
  })

  test('rejects empty and unbalanced quoted commands', () => {
    expect(getStartupCommandExecutable('')).toBeNull()
    expect(getStartupCommandExecutable('"C:\\Program Files\\Zcode\\zcode.cmd')).toBeNull()
  })
})
