import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

import { normalizePtyText, writeNodeCli } from '../helpers/platform-cli.js'
import { startAuthorizedTestServer as startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers = new Set<Awaited<ReturnType<typeof startTestServer>>>()
const dirs: string[] = []
afterEach(async () => {
  for (const server of servers) await server.close()
  servers.clear()
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
})

test('a failed first spawn does not prevent correcting the member launch configuration', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-failed-first-spawn-'))
  dirs.push(dataDir)
  vi.stubEnv('CODEX_HOME', join(dataDir, 'native-home'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath)
  const server = await startTestServer({ dataDir })
  servers.add(server)
  const workspace = server.store.createWorkspace(workspacePath, 'Correct launch')
  const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command: join(dataDir, 'missing-command'),
    commandPresetId: 'codex',
  })
  const cookie = await getUiCookie(server.baseUrl)
  const url = `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`
  const failed = await fetch(url, { method: 'POST', headers: { cookie } })
  expect(await failed.json()).toMatchObject({ error: expect.stringContaining('CLI not found') })
  const command = writeNodeCli(
    dataDir,
    'corrected-agent',
    "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"
  )
  server.store.configureAgentLaunch(workspace.id, worker.id, { command })
  const corrected = await fetch(url, { method: 'POST', headers: { cookie } })
  expect(corrected.status).toBe(201)
  const run = (await corrected.json()) as { run_id: string }
  await expect
    .poll(() => server.store.getLiveRun(run.run_id).output, { timeout: 3000 })
    .toContain('READY')
})

test('server restart keeps each member attached to its original native conversation and home', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-native-restart-'))
  dirs.push(dataDir)
  const workspacePath = join(dataDir, '项目 with space')
  mkdirSync(workspacePath)
  const nativeHome = join(dataDir, 'native-home')
  vi.stubEnv('CODEX_HOME', nativeHome)
  const command = writeNodeCli(
    dataDir,
    'codex-fixture',
    `
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const resumed = args[0] === 'resume'
const id = resumed ? args[1] : randomUUID()
const root = join(process.env.CODEX_HOME, 'sessions')
mkdirSync(root, { recursive: true })
const file = join(root, 'rollout-' + id + '.jsonl')
if (resumed) {
  process.stdout.write('RESTORED:' + readFileSync(file, 'utf8') + '\\n')
} else {
  writeFileSync(file, JSON.stringify({type:'session_meta',payload:{id,cwd:process.cwd()}}) + '\\n' +
    JSON.stringify({text:'Hive session binding: workspace_id=' + process.env.HIVE_PROJECT_ID + '; agent_id=' + process.env.HIVE_AGENT_ID}) + '\\n')
}
process.stdout.write('SESSION:' + id + '\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', text => {
  appendFileSync(file, JSON.stringify({text}) + '\\n')
  process.stdout.write('SAVED:' + text)
})
setInterval(() => {}, 1000)
`
  )
  const first = await startTestServer({ dataDir })
  servers.add(first)
  const workspace = first.store.createWorkspace(workspacePath, 'Persistent team')
  const alice = first.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  const bob = first.store.addWorker(workspace.id, { name: 'Bob', role: 'tester' })
  const members = [first.store.getWorkspaceSnapshot(workspace.id).agents[0], alice, bob]
  const cookie = await getUiCookie(first.baseUrl)
  for (const [index, member] of members.entries()) {
    if (!member) throw new Error('Expected orchestrator')
    first.store.configureAgentLaunch(workspace.id, member.id, {
      command,
      resumeArgsTemplate: 'resume {session_id}',
      sessionIdCapture: {
        source: 'codex_session_jsonl_dir',
        pattern: '~/.codex/sessions/**/*.jsonl',
      },
    })
    const response = await fetch(
      `${first.baseUrl}/api/workspaces/${workspace.id}/agents/${member.id}/start`,
      {
        method: 'POST',
        headers: { cookie },
      }
    )
    expect(response.status).toBe(201)
    const run = (await response.json()) as { run_id: string }
    await expect
      .poll(
        () =>
          first.store.listTerminalRuns(workspace.id).find((item) => item.agent_id === member.id)
            ?.thread_id,
        { timeout: 4000, interval: 25 }
      )
      .toBeTruthy()
    first.store.writeRunInput(run.run_id, `context-for-member-${index}\r`)
    await expect
      .poll(() => normalizePtyText(first.store.getLiveRun(run.run_id).output), {
        timeout: 4000,
        interval: 25,
      })
      .toContain(`SAVED:context-for-member-${index}`)
  }
  const bindings = first.store
    .listTerminalRuns(workspace.id)
    .map(({ agent_id, thread_id }) => ({ agent_id, thread_id }))
  expect(new Set(bindings.map((item) => item.thread_id)).size).toBe(3)
  await first.close()
  servers.delete(first)
  vi.stubEnv('CODEX_HOME', join(dataDir, 'other-launch-home'))
  const second = await startTestServer({ dataDir })
  servers.add(second)
  expect(second.store.listWorkspaces()).toEqual([workspace])
  expect(second.store.listWorkers(workspace.id).map((member) => member.id)).toEqual([
    alice.id,
    bob.id,
  ])
  const restored = await second.store.autoResumeInterruptedAgents({
    hivePort: new URL(second.baseUrl).port,
  })
  expect(restored).toHaveLength(3)
  expect(restored[0]).toMatchObject({ agentId: `${workspace.id}:orchestrator`, ok: true })
  expect(
    second.store
      .listTerminalRuns(workspace.id)
      .map(({ agent_id, thread_id }) => ({ agent_id, thread_id }))
  ).toEqual(bindings)
  for (const [index, member] of members.entries()) {
    const run = restored.find((item) => item.agentId === member?.id)
    expect(run?.ok).toBe(true)
    const restoredCookie = await getUiCookie(second.baseUrl)
    await expect
      .poll(
        async () => {
          const response = await fetch(`${second.baseUrl}/api/runtime/runs/${run?.runId}`, {
            headers: { cookie: restoredCookie },
          })
          expect(response.status).toBe(200)
          const body = (await response.json()) as { output: string }
          return normalizePtyText(body.output).replace(/\s/g, '')
        },
        { timeout: 4000, interval: 25 }
      )
      .toContain(`context-for-member-${index}`)
  }
}, 20_000)
