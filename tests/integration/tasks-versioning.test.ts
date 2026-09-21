import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Awaited<ReturnType<typeof startAuthorizedTestServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})
const fixture = async () => {
  const server = await startAuthorizedTestServer()
  servers.push(server)
  const path = join(server.dataDir, '中文 空格')
  mkdirSync(path)
  const workspace = server.store.createWorkspace(path, 'Tasks')
  const cookie = await getUiCookie(server.baseUrl)
  const url = `${server.baseUrl}/api/workspaces/${workspace.id}/tasks`
  const read = async () => (await fetch(url, { headers: { cookie } })).json()
  const write = (content: string, version?: string) =>
    fetch(url, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content, expected_version: version }),
    })
  return { server, path, workspace, read, write }
}

test('two HTTP writers of the same version produce one commit and one recoverable conflict', async () => {
  const f = await fixture(),
    original = await f.read()
  const responses = await Promise.all([
    f.write('- [ ] A\n', original.version),
    f.write('- [ ] B\n', original.version),
  ])
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
  const success = await responses.find((response) => response.status === 200)?.json()
  const failure = await responses.find((response) => response.status === 409)?.json()
  expect(failure).toMatchObject({ code: 'tasks_version_conflict', current: success })
  expect(await f.read()).toEqual(success)
  expect(readFileSync(join(f.path, '.hive', 'tasks.md'), 'utf8')).toBe(success.content)
  expect((await f.write('unversioned')).status).toBe(428)
  expect(await f.read()).toEqual(success)
})

test('external edits change the observed version and remain intact after a stale save', async () => {
  const f = await fixture(),
    original = await f.read()
  writeFileSync(join(f.path, '.hive', 'tasks.md'), '- [ ] 编辑器修改\n')
  const external = await f.read()
  expect(external.version).not.toBe(original.version)
  const response = await f.write('stale draft', original.version)
  expect(response.status).toBe(409)
  expect((await response.json()).current).toEqual(external)
  const merged = await f.write(`${external.content}- [ ] merged draft\n`, external.version)
  expect(merged.status).toBe(200)
  expect((await f.read()).content).toContain('编辑器修改')
})

const cli = (env: NodeJS.ProcessEnv, args: string[], input = '') =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((complete, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve('src/cli/team.ts'), 'tasks', ...args],
      { env, cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let stdout = '',
      stderr = ''
    child.stdout.setEncoding('utf8').on('data', (text) => {
      stdout += text
    })
    child.stderr.setEncoding('utf8').on('data', (text) => {
      stderr += text
    })
    child.once('error', reject)
    child.once('close', (code) => complete({ code, stdout, stderr }))
    child.stdin.end(input)
  })

test('the real team CLI reads and conditionally writes; worker writes and revoked identities are refused', async () => {
  const f = await fixture(),
    store = f.server.store
  const worker = store.addWorker(f.workspace.id, { name: 'Reader', role: 'coder' })
  const port = new URL(f.server.baseUrl).port
  const identities: Array<{ env: NodeJS.ProcessEnv; runId: string }> = []
  for (const agentId of [`${f.workspace.id}:orchestrator`, worker.id]) {
    store.configureAgentLaunch(f.workspace.id, agentId, {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    })
    const run = await store.startAgent(f.workspace.id, agentId, { hivePort: port })
    identities.push({
      runId: run.runId,
      env: {
        ...process.env,
        HIVE_PORT: port,
        HIVE_PROJECT_ID: f.workspace.id,
        HIVE_AGENT_ID: agentId,
        HIVE_AGENT_TOKEN: store.peekAgentToken(agentId),
      },
    })
  }
  const [orchestrator, reader] = identities
  if (!orchestrator || !reader) throw new Error('Both CLI identities must be running')
  const first = await cli(orchestrator.env, ['read'])
  expect(first.code, first.stderr).toBe(0)
  const snapshot = JSON.parse(first.stdout)
  const saved = await cli(
    orchestrator.env,
    ['write', '--expected-version', snapshot.version, '--stdin'],
    '- [ ] CLI 更新\n'
  )
  expect(saved.code, saved.stderr).toBe(0)
  expect((await f.read()).content).toBe('- [ ] CLI 更新\n')
  const workerRead = await cli(reader.env, ['read'])
  expect(workerRead.code, workerRead.stderr).toBe(0)
  const denied = await cli(
    reader.env,
    ['write', '--expected-version', JSON.parse(saved.stdout).version, '--stdin'],
    'worker overwrite'
  )
  expect(denied.code).toBe(1)
  expect(denied.stderr).toContain('403')
  store.stopAgentRun(reader.runId)
  const revoked = await cli(reader.env, ['read'])
  expect(revoked.code).toBe(1)
  expect(revoked.stderr).toContain('401')
  expect((await f.read()).content).toBe('- [ ] CLI 更新\n')
})
