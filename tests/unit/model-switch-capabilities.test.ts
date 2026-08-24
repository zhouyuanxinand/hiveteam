import { describe, expect, test } from 'vitest'

import { getModelSwitchCapability } from '../../src/server/model-switch-capabilities.js'

describe('model switch capabilities', () => {
  test.each([
    'codex',
    'claude',
    'gemini',
    'qwen',
    'kimi',
    'hermes',
    'agy',
    'cursor-agent',
  ])('opens the native /model picker for %s', (command) => {
    expect(getModelSwitchCapability(command)).toMatchObject({
      input: '/model\r',
      pickerCommand: '/model',
      strategy: 'native-picker',
    })
  })

  test('uses OpenCode’s documented plural picker command', () => {
    expect(getModelSwitchCapability('opencode.cmd')).toMatchObject({
      input: '/models\r',
      pickerCommand: '/models',
    })
  })

  test('does not claim a picker for the desktop-only ZCode executable', () => {
    expect(getModelSwitchCapability('ZCode.exe')).toBeUndefined()
  })
})
