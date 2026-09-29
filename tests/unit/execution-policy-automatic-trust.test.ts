import { expect, test } from 'vitest'
import type { AgentLaunchConfigInput } from '../../src/server/agent-run-store.js'
import type { CommandPresetRecord } from '../../src/server/command-preset-store.js'
import { automaticTrustFingerprint } from '../../src/server/execution-policy-automatic-trust.js'

const fingerprint = (
  command: string,
  args: string[],
  presetChanges: Partial<CommandPresetRecord> = {}
) => {
  const config: AgentLaunchConfigInput = { command, args, commandPresetId: 'fixture' }
  const preset: CommandPresetRecord = {
    id: 'fixture',
    command,
    args: [],
    displayName: 'Fixture',
    env: {},
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: null,
    isBuiltin: false,
    ...presetChanges,
  }
  return automaticTrustFingerprint(
    config,
    {
      id: 'fixture',
      available: true,
      executable: command,
      launcher: command,
      version: null,
      fingerprint: 'member-specific',
      artifactFingerprint: 'byte-verified',
    },
    preset
  )
}

test('known AI model changes preserve the automatic preference, while execution flags invalidate it', () => {
  expect(fingerprint('codex', ['--model', 'model-a'])).toBe(fingerprint('codex', ['-m', 'model-b']))
  expect(fingerprint('codex', ['--model=model-c'])).toBe(fingerprint('codex', []))
  expect(
    fingerprint('codex', ['--model', 'model-a', '--dangerously-bypass-approvals-and-sandbox'])
  ).not.toBe(fingerprint('codex', ['--model', 'model-a']))
})

test('unknown CLI module flags are executable identity, never interchangeable model choices', () => {
  expect(fingerprint('python', ['-m', 'safe_module'])).not.toBe(
    fingerprint('python', ['-m', 'other_module'])
  )
  expect(fingerprint('custom-cli', ['--model', 'safe_module'])).not.toBe(
    fingerprint('custom-cli', ['--model', 'other_module'])
  )
})

test('preset launch changes invalidate a remembered preference even before existing members reconfigure', () => {
  const current = fingerprint('codex', [])
  expect(
    fingerprint('codex', [], { args: ['--dangerously-bypass-approvals-and-sandbox'] })
  ).not.toBe(current)
  expect(fingerprint('codex', [], { env: { CODEX_HOME: 'different-home' } })).not.toBe(current)
  expect(
    fingerprint('codex', [], { yoloArgsTemplate: ['--dangerously-bypass-approvals-and-sandbox'] })
  ).not.toBe(current)
})
