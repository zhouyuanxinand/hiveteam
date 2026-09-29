import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { withCodexProcessIsolation } from '../../src/server/codex-process-isolation.js'
import { readExecutionCliIdentity } from '../../src/server/execution-cli-identity.js'
import { createManagedExecution } from '../../src/server/managed-execution.js'
import { writeNodeCli } from '../helpers/platform-cli.js'
import { createTestResourceBudget } from '../helpers/resource-budget.js'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of directories.splice(0))
    rmSync(dir, { force: true, recursive: true, maxRetries: 5 })
})

test('a newly installed Codex artifact advertises isolation through real help without trusting its version', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-codex-capability-'))
  directories.push(directory)
  const cwd = join(directory, '工作区 & spaces')
  mkdirSync(cwd)
  const observed = join(directory, 'probe.json')
  const executable = writeNodeCli(
    directory,
    'codex',
    String.raw`
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ args, hive: Object.keys(process.env).some(key => key.startsWith('HIVE_')), secret: Boolean(process.env.SYNTHETIC_CLOUD_KEY) }))
if (JSON.stringify(args) !== JSON.stringify(['--help'])) process.exit(9)
console.log('Codex CLI\n\nUsage: codex [OPTIONS] [PROMPT]\n\nOptions:\n      --no-daemon  Run a dedicated process\n  -h, --help  Print help')
`
  )
  const config = {
    command: executable,
    commandPresetId: 'codex',
    args: ['resume', 'retained-id', '-c', 'model_reasoning_effort="ultra"'],
  }
  const identity = await readExecutionCliIdentity(config, cwd)
  expect(identity.version).toBeNull()
  const resources = createTestResourceBudget()
  const execution = createManagedExecution(
    resources,
    resources.reserve({
      workspaceId: 'workspace',
      executionKey: 'agent:fixture',
      kind: 'orchestrator',
      agentId: 'fixture',
    })
  )
  vi.stubEnv('SYNTHETIC_CLOUD_KEY', 'fixture-secret')
  const result = await withCodexProcessIsolation(config, identity, {
    cwd,
    env: { HIVE_AGENT_TOKEN: 'fixture-token', HIVE_SUPERVISOR_TOKEN: 'fixture-management' },
    execution,
    assertPolicy: async () => {},
  })
  expect(result.args).toEqual([
    'resume',
    'retained-id',
    '-c',
    'model_reasoning_effort="ultra"',
    '--no-daemon',
  ])
  expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({
    args: ['--help'],
    hive: false,
    secret: false,
  })
  expect(resources.getSnapshot().reservations).toEqual([
    expect.objectContaining({ state: 'reserved', pid: null, run_id: null }),
  ])
  execution.cancelBeforeSpawn()
})

const prepare = (cwd: string) => {
  const resources = createTestResourceBudget()
  const execution = createManagedExecution(
    resources,
    resources.reserve({
      workspaceId: 'workspace',
      executionKey: 'agent:fixture',
      kind: 'orchestrator',
      agentId: 'fixture',
    })
  )
  return { cwd, env: {}, execution, assertPolicy: async () => {}, resources }
}

test('re-probes changed executable bytes after caching an older CLI without isolation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-codex-upgrade-'))
  directories.push(directory)
  const legacy = 'Codex CLI\nUsage: codex [OPTIONS]\nOptions:\n  -h, --help  Print help'
  const command = writeNodeCli(directory, 'codex', `console.log(${JSON.stringify(legacy)})`)
  const config = { command, commandPresetId: 'codex' }
  const first = await readExecutionCliIdentity(config, directory)
  const context = prepare(directory)
  expect(await withCodexProcessIsolation(config, first, context)).toEqual(config)
  writeNodeCli(
    directory,
    'codex',
    `console.log(${JSON.stringify(`${legacy}\n      --no-daemon  Dedicated process`)})`
  )
  const second = await readExecutionCliIdentity(config, directory)
  expect(second.fingerprint).not.toBe(first.fingerprint)
  expect(second.version).toBeNull()
  expect((await withCodexProcessIsolation(config, second, context)).args).toEqual(['--no-daemon'])
  context.execution.cancelBeforeSpawn()
})

test('a hanging help probe fails, closes its child, and leaves the reserved slot usable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-codex-help-timeout-'))
  directories.push(directory)
  const pidFile = join(directory, 'pid.json')
  const command = writeNodeCli(
    directory,
    'codex',
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(process.pid)); setInterval(() => {}, 1000)`
  )
  const config = { command, commandPresetId: 'codex' }
  const identity = await readExecutionCliIdentity(config, directory)
  const context = prepare(directory)
  await expect(withCodexProcessIsolation(config, identity, context)).rejects.toThrow(
    'preparation timed out'
  )
  const pid = JSON.parse(readFileSync(pidFile, 'utf8'))
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  expect(context.resources.getSnapshot().reservations).toEqual([
    expect.objectContaining({ state: 'reserved', pid: null, run_id: null }),
  ])
  context.execution.cancelBeforeSpawn()
})
