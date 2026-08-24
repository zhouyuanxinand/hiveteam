import { describe, expect, test } from 'vitest'

import { supportsModelSelection, withModelArgument } from '../../src/server/model-arguments.js'

describe('model arguments', () => {
  test('supports the built-in CLI model flags', () => {
    expect(supportsModelSelection('codex')).toBe(true)
    expect(supportsModelSelection('ZCode.exe')).toBe(false)
    expect(supportsModelSelection('kimi')).toBe(true)
    expect(supportsModelSelection('custom-agent')).toBe(false)
  })

  test('replaces an existing model argument without duplicating it', () => {
    expect(withModelArgument(['--model', 'old', '--yolo'], 'codex', 'new')).toEqual([
      '--yolo',
      '--model',
      'new',
    ])
    expect(withModelArgument(['--model=old'], 'codex', 'new')).toEqual(['--model', 'new'])
  })

  test('leaves custom commands and empty model values unchanged', () => {
    expect(withModelArgument(['--flag'], 'custom-agent', 'new')).toEqual(['--flag'])
    expect(withModelArgument(['--flag'], 'codex', '  ')).toEqual(['--flag'])
  })
})
