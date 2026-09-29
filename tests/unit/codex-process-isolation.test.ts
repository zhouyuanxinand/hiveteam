import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { withCodexProcessIsolation } from '../../src/server/codex-process-isolation.js'
import { createManagedExecution } from '../../src/server/managed-execution.js'
import * as nativeProcess from '../../src/server/native-session-process.js'
import { createTestResourceBudget } from '../helpers/resource-budget.js'

const HELP =
  'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\nOptions:\n      --no-daemon  Use a dedicated process\n  -h, --help  Print help'
const LEGACY_HELP = 'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\nOptions:\n  -h, --help  Print help'
afterEach(() => vi.restoreAllMocks())
const fixture = (help = HELP) => {
  const probe = vi
    .spyOn(nativeProcess, 'runNativeSessionProcess')
    .mockResolvedValue({ stdout: help, stderr: '', exitCode: 0 })
  const resources = createTestResourceBudget()
  const execution = createManagedExecution(
    resources,
    resources.reserve({
      workspaceId: 'fixture-workspace',
      executionKey: 'fixture-agent',
      kind: 'orchestrator',
    })
  )
  const preparation = { cwd: process.cwd(), env: {}, execution, assertPolicy: async () => {} }
  const identity = {
    id: 'codex',
    version: null,
    executable: process.execPath,
    launcher: process.execPath,
    fingerprint: randomUUID(),
  }
  return { probe, identity, preparation }
}

test.each([
  null,
  'codex-cli 0.155.1',
  'codex-cli 0.158.0',
  'codex-cli 0.159.0',
])('uses advertised capability independently of security version %s', async (version) => {
  const { identity, preparation } = fixture()
  const config = { command: 'codex', args: ['-c', 'model_reasoning_effort="ultra"'] }
  expect(await withCodexProcessIsolation(config, { ...identity, version }, preparation)).toEqual({
    ...config,
    args: [...config.args, '--no-daemon'],
  })
})

test('leaves a legacy CLI without the option compatible', async () => {
  const { identity, preparation } = fixture(LEGACY_HELP)
  const config = { command: 'codex', args: ['-c', 'model_reasoning_effort="ultra"'] }
  expect(await withCodexProcessIsolation(config, identity, preparation)).toEqual(config)
})

test('does not probe or change another CLI', async () => {
  const { identity, preparation, probe } = fixture()
  probe.mockRejectedValue(new Error('must not probe this CLI'))
  const config = { command: 'claude', args: ['--resume'] }
  expect(
    await withCodexProcessIsolation(config, { ...identity, id: 'claude' }, preparation)
  ).toEqual(config)
})

test('keeps explicit process isolation and native resume options without duplication', async () => {
  const { identity, preparation } = fixture()
  const config = {
    command: 'codex',
    args: ['resume', 'native-session', '-c', 'model_reasoning_effort="ultra"', '--no-daemon'],
  }
  expect(await withCodexProcessIsolation(config, identity, preparation)).toEqual(config)
})

test.each([
  [
    ['--', 'user prompt'],
    ['--no-daemon', '--', 'user prompt'],
  ],
  [
    ['--', '--no-daemon'],
    ['--no-daemon', '--', '--no-daemon'],
  ],
  [
    ['--no-daemon', '--', 'user prompt'],
    ['--no-daemon', '--', 'user prompt'],
  ],
])('inserts process isolation before the prompt delimiter in %j', async (args, expectedArgs) => {
  const { identity, preparation } = fixture()
  expect(
    (await withCodexProcessIsolation({ command: 'codex', args }, identity, preparation)).args
  ).toEqual(expectedArgs)
})

test.each([
  '',
  'something mentioned --no-daemon',
  'Usage: another-cli [OPTIONS]',
])('rejects unrecognized help instead of assuming a legacy CLI (%j)', async (help) => {
  const { identity, preparation } = fixture(help)
  await expect(
    withCodexProcessIsolation({ command: 'codex' }, identity, preparation)
  ).rejects.toMatchObject({
    code: 'execution_policy_denied',
    missingCapabilities: ['codex_process_isolation_probe_failed'],
  })
})

test('only an advertised option enables isolation, not a prose mention', async () => {
  const { identity, preparation } = fixture(
    `${LEGACY_HELP}\nThis older Codex does not implement --no-daemon.`
  )
  const config = { command: 'codex' }
  expect(await withCodexProcessIsolation(config, identity, preparation)).toEqual(config)
})

test('preserves probe failures and retries them rather than caching absence', async () => {
  const { identity, preparation, probe } = fixture()
  const failure = new Error('synthetic process could not start')
  probe.mockRejectedValueOnce(failure)
  await expect(withCodexProcessIsolation({ command: 'codex' }, identity, preparation)).rejects.toBe(
    failure
  )
  expect(
    (await withCodexProcessIsolation({ command: 'codex' }, identity, preparation)).args
  ).toEqual(['--no-daemon'])
})

test('rejects a nonzero help exit even if it emitted the option', async () => {
  const { identity, preparation, probe } = fixture()
  probe.mockResolvedValueOnce({ stdout: HELP, stderr: '', exitCode: 7 })
  await expect(
    withCodexProcessIsolation({ command: 'codex' }, identity, preparation)
  ).rejects.toThrow('exit code 7')
})

test('rechecks authorization before using a cached capability', async () => {
  const { identity, preparation } = fixture()
  const config = { command: 'codex' }
  expect((await withCodexProcessIsolation(config, identity, preparation)).args).toEqual([
    '--no-daemon',
  ])
  const revoked = new Error('execution authorization revoked')
  await expect(
    withCodexProcessIsolation(config, identity, {
      ...preparation,
      assertPolicy: async () => {
        throw revoked
      },
    })
  ).rejects.toBe(revoked)
})

test('isolates a new native Codex executable behind a UUID custom preset', async () => {
  const { identity, preparation } = fixture()
  const config = {
    command: 'custom-codex',
    commandPresetId: randomUUID(),
    args: ['resume', 'existing-thread'],
  }
  const customIdentity = {
    ...identity,
    id: config.commandPresetId,
    executable: 'D:/Tools/Codex/codex.exe',
  }
  expect((await withCodexProcessIsolation(config, customIdentity, preparation)).args).toEqual([
    'resume',
    'existing-thread',
    '--no-daemon',
  ])
})

test.each([
  'codex',
  'codex.js',
  'codex.cmd',
  'codex.ps1',
])('recognizes the resolved %s launcher behind a custom preset', async (name) => {
  const { identity, preparation } = fixture()
  const config = { command: name, commandPresetId: randomUUID() }
  expect(
    (
      await withCodexProcessIsolation(
        config,
        { ...identity, id: config.commandPresetId, launcher: `/tools/${name}` },
        preparation
      )
    ).args
  ).toEqual(['--no-daemon'])
})

test('does not treat arbitrary Node executables in custom presets as Codex', async () => {
  const { identity, preparation, probe } = fixture()
  probe.mockRejectedValue(new Error('must not probe arbitrary Node'))
  const config = {
    command: process.execPath,
    commandPresetId: randomUUID(),
    args: ['other-cli.js'],
  }
  expect(
    await withCodexProcessIsolation(
      config,
      { ...identity, id: config.commandPresetId },
      preparation
    )
  ).toEqual(config)
})

test('preserves the missing CLI diagnosis before capability discovery', async () => {
  const { identity, preparation } = fixture()
  const command = join(tmpdir(), `missing-codex-${randomUUID()}`, 'codex.exe')
  await expect(
    withCodexProcessIsolation(
      { command },
      { ...identity, executable: null, launcher: null },
      preparation
    )
  ).rejects.toMatchObject({
    code: 'ENOENT',
    path: command,
    message: `${command} CLI not found in PATH`,
  })
})

test('rejects an executable without a resolved identity rather than skipping isolation', async () => {
  const { identity, preparation } = fixture()
  await expect(
    withCodexProcessIsolation(
      { command: process.execPath },
      { ...identity, executable: null, launcher: null },
      preparation
    )
  ).rejects.toMatchObject({
    code: 'execution_policy_denied',
    missingCapabilities: ['codex_process_isolation_probe_failed'],
  })
})
