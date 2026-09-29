import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { writeCodexCli } from '../helpers/codex-cli.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers = new Set<Awaited<ReturnType<typeof startAuthorizedTestServer>>>()
const directories: string[] = []
afterEach(async () => {
  for (const server of servers) await server.close()
  servers.clear()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 })
})

test('cursor-addressed Codex startup binds the conversation and restores its answer after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-codex-startup-recovery-'))
  directories.push(directory)
  const workspacePath = join(directory, '项目 with space')
  mkdirSync(workspacePath)
  const nativeHome = join(directory, 'native')
  const dataDir = join(directory, 'runtime')
  const first = await startAuthorizedTestServer({ dataDir })
  servers.add(first)
  const workspace = first.store.createWorkspace(workspacePath, 'Restart conversation')
  const agentId = `${workspace.id}:orchestrator`
  const script = resolve('tests/fixtures/codex-recovery-tui.mjs')
  first.store.configureAgentLaunch(workspace.id, agentId, {
    command: writeCodexCli(
      directory,
      `await import(${JSON.stringify(pathToFileURL(script).href)})`
    ),
    args: [nativeHome],
    interactiveCommand: 'codex',
    presetAugmentationDisabled: true,
    resumeArgsTemplate: 'resume {session_id}',
    sessionIdCapture: {
      source: 'codex_session_jsonl_dir',
      pattern: join(nativeHome, 'sessions', '**', '*.jsonl'),
    },
  })
  const cookie = await getUiCookie(first.baseUrl)
  const response = await fetch(
    `${first.baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`,
    {
      method: 'POST',
      headers: { cookie },
    }
  )
  expect(response.status).toBe(201)
  const run = (await response.json()) as { run_id: string }
  const read = async (server: typeof first, sessionCookie: string, runId: string) => {
    const result = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/agents/${agentId}/conversation?run_id=${runId}`,
      { headers: { cookie: sessionCookie } }
    )
    expect(result.status).toBe(200)
    return result.json()
  }
  await expect
    .poll(async () => (await read(first, cookie, run.run_id)).turns.at(-1)?.answer, {
      timeout: 15_000,
    })
    .toBe('Preserved original answer')
  const original = await read(first, cookie, run.run_id)
  expect(original.session_id).toBeTruthy()
  expect(JSON.parse(readFileSync(join(nativeHome, 'launch.json'), 'utf8'))).toMatchObject({
    id: original.session_id,
    resumed: false,
    accepted: 1,
  })
  await first.close()
  servers.delete(first)
  const second = await startAuthorizedTestServer({ dataDir })
  servers.add(second)
  const resumed = await second.store.autoResumeInterruptedAgents({
    hivePort: new URL(second.baseUrl).port,
  })
  expect(resumed).toHaveLength(1)
  expect(resumed[0]).toMatchObject({ agentId, ok: true })
  const secondCookie = await getUiCookie(second.baseUrl)
  const secondRun = resumed[0]
  if (!secondRun?.ok || !secondRun.runId) throw new Error('Expected restored run')
  await expect
    .poll(() => JSON.parse(readFileSync(join(nativeHome, 'launch.json'), 'utf8')).resumed, {
      timeout: 10_000,
    })
    .toBe(true)
  const restored = await read(second, secondCookie, secondRun.runId)
  expect(restored.session_id).toBe(original.session_id)
  expect(restored.turns).toEqual(original.turns)
  expect(JSON.parse(readFileSync(join(nativeHome, 'launch.json'), 'utf8'))).toMatchObject({
    id: original.session_id,
    resumed: true,
    accepted: 0,
  })
}, 30_000)
