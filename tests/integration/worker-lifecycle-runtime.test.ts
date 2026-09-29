import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { runGit } from '../../src/server/git-command.js'
import Database from '../../src/server/sqlite.js'
import {
  createTeamMailboxBroker,
  type TeamMailboxBroker,
} from '../../src/server/team-mailbox-broker.js'
import type { TeamListItemPayload } from '../../src/shared/types.js'
import { startAuthorizedTestServer, type TestServerContext } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const brokers = new Set<TeamMailboxBroker>()
const servers = new Set<TestServerContext>(),
  directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const broker of brokers) await broker.close()
  brokers.clear()
  for (const server of servers) await server.close()
  servers.clear()
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const open = async (dataDir: string) => {
  const server = await startAuthorizedTestServer({ dataDir })
  servers.add(server)
  return server
}
const close = async (server: TestServerContext) => {
  await server.close()
  servers.delete(server)
}
const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-staffing-runtime-'))
  directories.push(dir)
  const root = join(dir, 'project')
  mkdirSync(root)
  writeFileSync(join(root, '.gitignore'), '.hive/\n*.runtime\n')
  writeFileSync(
    join(root, 'agent.cjs'),
    `const fs=require('node:fs');fs.writeFileSync(process.env.HIVE_AGENT_ID.replaceAll(':','_')+'.runtime',JSON.stringify({cwd:process.cwd(),id:process.env.HIVE_AGENT_ID}));if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.on('data',data=>console.log('INPUT:'+data));console.log('STAFF_READY');`
  )
  await runGit(root, ['init', '-b', 'main'])
  await runGit(root, ['config', 'user.name', 'Lifecycle Test'])
  await runGit(root, ['config', 'user.email', 'lifecycle@example.com'])
  await runGit(root, ['add', '.'])
  await runGit(root, ['commit', '-m', 'Initial fixture'])
  const server = await open(join(dir, 'data'))
  const workspace = server.store.createWorkspace(root, 'Staffing', 'en')
  const preset = server.store.settings.createCommandPreset({
    command: process.execPath,
    args: ['agent.cjs'],
    displayName: 'Fixture CLI',
    env: {},
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: null,
  })
  const actor = `${workspace.id}:orchestrator`
  server.store.configureAgentLaunch(workspace.id, actor, {
    command: process.execPath,
    args: ['agent.cjs'],
  })
  const run = await server.store.startAgent(workspace.id, actor, {
    hivePort: new URL(server.baseUrl).port,
  })
  await expect
    .poll(() => server.store.getLiveRun(run.runId).output, { timeout: 12000 })
    .toContain('STAFF_READY')
  const cookie = await getUiCookie(server.baseUrl)
  const ui = (path: string, method = 'GET', body?: unknown) =>
    fetch(server.baseUrl + path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const policyPath = `/api/ui/workspaces/${workspace.id}/staffing-policy`
  const enable = async (max = 2) => {
    const response = await ui(policyPath, 'PUT', {
      enabled: true,
      allowed_command_preset_ids: [preset.id],
      max_ephemeral_workers: max,
    })
    expect(response.status).toBe(200)
  }
  const post = (path: string, body: object, from = actor) =>
    fetch(server.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        project_id: workspace.id,
        from_agent_id: from,
        token: server.store.peekAgentToken(from),
      }),
    })
  const create = (name: string, extra: object = {}) =>
    post('/api/team/spawn', {
      name,
      role: 'coder',
      command_preset_id: preset.id,
      autostart: false,
      ...extra,
    })
  return { server, workspace, preset, actor, ui, post, enable, create, root, dir, policyPath }
}
const cli = (
  server: TestServerContext,
  workspaceId: string,
  actor: string,
  args: string[],
  mailbox = ''
) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'bin/team', ...args], {
      windowsHide: true,
      timeout: 45000,
      env: {
        ...process.env,
        HIVE_PROJECT_ID: workspaceId,
        HIVE_AGENT_ID: actor,
        HIVE_AGENT_TOKEN: server.store.peekAgentToken(actor) ?? '',
        HIVE_PORT: new URL(server.baseUrl).port,
        HIVE_TEAM_MAILBOX: mailbox,
      },
    })
    let stdout = '',
      stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (text) => {
      stdout += text
    })
    child.stderr?.setEncoding('utf8').on('data', (text) => {
      stderr += text
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
type Created = TeamListItemPayload & {
  agent_start: { ok: boolean; error: string | null; run_id: string | null }
}
const withDb = <T>(server: TestServerContext, read: (db: Database) => T) => {
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  try {
    return read(db)
  } finally {
    db.close()
  }
}

test('real CLI creates an isolated member and dismissal preserves reports, skills and the worktree across restart', async () => {
  const f = await setup()
  await f.enable()
  const broker = await createTeamMailboxBroker({
    root: join(f.dir, 'mailbox'),
    workspaceId: f.workspace.id,
    agentId: f.actor,
    token: f.server.store.peekAgentToken(f.actor) ?? '',
    hivePort: new URL(f.server.baseUrl).port,
    isActive: () => true,
  })
  brokers.add(broker)
  const config = await cli(f.server, f.workspace.id, f.actor, ['staffing'], broker.path)
  expect(config.code, config.stderr).toBe(0)
  expect(JSON.parse(config.stdout).enabled).toBe(true)
  const created = await cli(
    f.server,
    f.workspace.id,
    f.actor,
    [
      'spawn',
      '--name',
      'Inspector',
      '--role',
      'reviewer',
      '--preset',
      f.preset.id,
      '--description',
      'Review API contracts',
      '--isolated',
    ],
    broker.path
  )
  expect(created.code, created.stderr).toBe(0)
  const worker = JSON.parse(created.stdout) as Created
  expect(worker).toMatchObject({
    name: 'Inspector',
    role: 'reviewer',
    lifecycle_kind: 'ephemeral',
    spawned_by_agent_id: f.actor,
    command_preset_id: f.preset.id,
    agent_start: { ok: true, error: null },
  })
  expect(f.server.store.getAgent(f.workspace.id, worker.id).description).toBe(
    'Review API contracts'
  )
  const cwd = worker.working_directory
  if (!cwd) throw new Error('Expected isolated working directory')
  expect(cwd).not.toBe(f.root)
  expect(JSON.parse(readFileSync(join(cwd, `${worker.id}.runtime`), 'utf8'))).toMatchObject({
    id: worker.id,
    cwd,
  })
  const sent = await cli(f.server, f.workspace.id, f.actor, ['send', 'Inspector', 'Inspect API'])
  expect(sent.code, sent.stderr).toBe(0)
  const dispatch = f.server.store.listDispatches(f.workspace.id)[0]
  if (!dispatch) throw new Error('Expected dispatch')
  // Preserve a real pending report for the next runtime to drain.
  await f.server.store.dispatchDelivery.close()
  const reported = await cli(f.server, f.workspace.id, worker.id, [
    'report',
    'API checked',
    '--dispatch',
    dispatch.id,
    '--outcome',
    'success',
    '--artifact',
    'evidence.txt',
  ])
  expect(reported.code, reported.stderr).toBe(0)
  writeFileSync(join(cwd, 'evidence.txt'), 'review evidence')
  const skillId = randomUUID()
  withDb(f.server, (db) =>
    db
      .prepare(
        'INSERT INTO skill_snapshots(id,workspace_id,agent_id,snapshot_json,fingerprint,status,created_at) VALUES(?,?,?,?,?,?,?)'
      )
      .run(
        skillId,
        f.workspace.id,
        worker.id,
        JSON.stringify({ source: 'fixture', skill: 'review-api' }),
        'fixture-hash',
        'ready',
        Date.now()
      )
  )
  const before = withDb(f.server, (db) => ({
    report: db.prepare('SELECT * FROM report_outbox WHERE dispatch_id=?').get(dispatch.id),
    skill: db.prepare('SELECT * FROM skill_snapshots WHERE id=?').get(skillId),
  }))
  expect(before.report).toMatchObject({ delivered_at: null })
  const dismissed = await cli(
    f.server,
    f.workspace.id,
    f.actor,
    ['dismiss', '--worker', worker.id],
    broker.path
  )
  await broker.close()
  brokers.delete(broker)
  expect(dismissed.code, dismissed.stderr).toBe(0)
  const retired = JSON.parse(dismissed.stdout) as TeamListItemPayload
  expect(retired).toMatchObject({
    id: worker.id,
    status: 'stopped',
    retired_at: expect.any(Number),
  })
  await expect
    .poll(() => f.server.store.getLiveRun(worker.agent_start.run_id ?? '').status, {
      timeout: 10000,
    })
    .toBe('exited')
  expect(f.server.store.listWorkers(f.workspace.id)).toEqual([])
  expect(
    withDb(f.server, (db) => ({
      report: db.prepare('SELECT * FROM report_outbox WHERE dispatch_id=?').get(dispatch.id),
      skill: db.prepare('SELECT * FROM skill_snapshots WHERE id=?').get(skillId),
    }))
  ).toEqual(before)
  expect((await f.post('/api/team/send', { to: 'Inspector', text: 'New work' })).status).toBe(409)
  expect(
    (await f.ui(`/api/workspaces/${f.workspace.id}/agents/${worker.id}/start`, 'POST')).status
  ).toBe(409)
  await close(f.server)
  const restored = await open(join(f.dir, 'data'))
  const results = await restored.store.autoResumeInterruptedAgents({
    hivePort: new URL(restored.baseUrl).port,
  })
  expect(results.some((result) => result.agentId === worker.id)).toBe(false)
  expect(restored.store.workerLifecycle.get(f.workspace.id, worker.id)).toMatchObject({
    retired_at: retired.retired_at,
    working_directory: cwd,
    status: 'stopped',
  })
  expect(restored.store.listWorkers(f.workspace.id)).toEqual([])
  expect(readFileSync(join(cwd, 'evidence.txt'), 'utf8')).toBe('review evidence')
  await restored.store.startAgent(f.workspace.id, f.actor, {
    hivePort: new URL(restored.baseUrl).port,
  })
  await expect
    .poll(() => restored.store.getActiveRunByAgentId(f.workspace.id, f.actor)?.output, {
      timeout: 20000,
    })
    .toContain('API checked')
  expect(restored.store.getDispatch(f.workspace.id, dispatch.id)).toMatchObject({
    reportText: 'API checked',
    status: 'reported',
    artifacts: ['evidence.txt'],
  })
}, 90000)

test('policy, role, workspace and cap checks reject requests without creating members', async () => {
  const f = await setup()
  expect((await f.ui(f.policyPath)).status).toBe(200)
  expect(f.server.store.workerLifecycle.readPolicy(f.workspace.id)).toEqual({
    enabled: false,
    allowed_command_preset_ids: [],
    max_ephemeral_workers: 2,
  })
  expect((await f.create('Disabled')).status).toBe(403)
  expect((await f.post(f.policyPath, { enabled: true })).status).toBe(404)
  const unauth = await fetch(f.server.baseUrl + f.policyPath, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      allowed_command_preset_ids: [f.preset.id],
      max_ephemeral_workers: 2,
    }),
  })
  expect(unauth.status).toBe(403)
  await f.enable(1)
  expect((await f.create('Override', { startup_command: 'echo override' })).status).toBe(400)
  expect((await f.create('Unlisted', { command_preset_id: 'claude' })).status).toBe(403)
  expect((await f.create('Wrong role', { role: 'orchestrator' })).status).toBe(400)
  expect((await f.create('Missing preset', { command_preset_id: 'does-not-exist' })).status).toBe(
    400
  )
  const response = await f.create('One', { autostart: true })
  expect(response.status).toBe(201)
  const worker = (await response.json()) as Created
  expect(worker.agent_start.ok).toBe(true)
  expect(
    (
      await f.post(
        '/api/team/spawn',
        { name: 'Nested', role: 'coder', command_preset_id: f.preset.id },
        worker.id
      )
    ).status
  ).toBe(403)
  expect((await f.post('/api/team/dismiss', { worker_id: worker.id }, worker.id)).status).toBe(403)
  expect((await f.create('Overflow')).status).toBe(409)
  expect(f.server.store.listWorkers(f.workspace.id).map((item) => item.name)).toEqual(['One'])
  const dispatch = await f.server.store.dispatchTask(f.workspace.id, worker.id, 'Outstanding task')
  const live = worker.agent_start.run_id
  if (!live) throw new Error('Expected live worker')
  expect((await f.post('/api/team/dismiss', { worker_id: worker.id })).status).toBe(409)
  expect(f.server.store.getLiveRun(live).status).not.toBe('exited')
  expect(f.server.store.getAgent(f.workspace.id, worker.id).retiredAt).toBeUndefined()
  expect(
    (await f.post('/api/team/cancel', { dispatch_id: dispatch.id, reason: 'Cancelled by owner' }))
      .status
  ).toBe(202)
  const manual = f.server.store.addWorker(f.workspace.id, { name: 'Manual', role: 'tester' })
  expect((await f.post('/api/team/dismiss', { worker_id: manual.id })).status).toBe(403)
  const other = f.server.store.createWorkspace(f.root, 'Other')
  expect(
    (await f.post('/api/team/dismiss', { worker_id: `${other.id}:orchestrator` })).status
  ).toBe(404)
  await f.ui(f.policyPath, 'PUT', {
    enabled: false,
    allowed_command_preset_ids: [f.preset.id],
    max_ephemeral_workers: 1,
  })
  expect((await f.post('/api/team/dismiss', { worker_id: worker.id })).status).toBe(200)
  expect((await f.post('/api/team/dismiss', { worker_id: worker.id })).status).toBe(200)
  expect((await f.create('Disabled again')).status).toBe(403)
  await f.enable(1)
  const concurrent = await Promise.all([f.create('Replacement'), f.create('Concurrent')])
  expect(concurrent.map((response) => response.status).sort()).toEqual([201, 409])
  expect(
    f.server.store.listWorkers(f.workspace.id).filter((item) => item.lifecycleKind === 'ephemeral')
  ).toHaveLength(1)
  const history = await f.ui(`/api/ui/workspaces/${f.workspace.id}/members/retired`)
  expect(history.status).toBe(200)
  expect(await history.json()).toEqual([
    expect.objectContaining({ id: worker.id, retired_at: expect.any(Number) }),
  ])
}, 90000)

test('failed worktree preparation is durable and never starts in the shared directory', async () => {
  const f = await setup()
  await f.enable()
  writeFileSync(join(f.root, 'uncommitted.txt'), 'dirty workspace')
  const response = await f.create('Failed', { isolated: true, autostart: true })
  expect(response.status).toBe(201)
  const worker = (await response.json()) as Created
  expect(worker).toMatchObject({
    status: 'stopped',
    preparation_state: 'failed',
    preparation_error: expect.any(String),
    agent_start: { ok: false, run_id: null, error: expect.any(String) },
  })
  expect(f.server.store.worktrees.get(f.workspace.id, worker.id)).toBeUndefined()
  expect(existsSync(join(f.root, `${worker.id}.runtime`))).toBe(false)
  expect(
    (await f.ui(`/api/workspaces/${f.workspace.id}/agents/${worker.id}/start`, 'POST')).status
  ).toBe(409)
  await close(f.server)
  const restored = await open(join(f.dir, 'data'))
  expect(restored.store.workerLifecycle.get(f.workspace.id, worker.id)).toMatchObject({
    preparation_state: 'failed',
    preparation_error: worker.preparation_error,
  })
  await expect(
    restored.store.startAgent(f.workspace.id, worker.id, {
      hivePort: new URL(restored.baseUrl).port,
    })
  ).rejects.toThrow(worker.preparation_error)
  expect(existsSync(join(f.root, `${worker.id}.runtime`))).toBe(false)
}, 60000)

test('dismissal cancels a pending launch before a native process can appear', async () => {
  const f = await setup()
  await f.enable()
  const worker = (await (await f.create('Preparing start')).json()) as Created
  const prepare = f.server.store.executionPolicies.prepare.bind(f.server.store.executionPolicies)
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reached = false
  vi.spyOn(f.server.store.executionPolicies, 'prepare').mockImplementation(async (input) => {
    const prepared = await prepare(input)
    if (input.agentId === worker.id) {
      reached = true
      await gate
    }
    return prepared
  })
  const start = f.ui(`/api/workspaces/${f.workspace.id}/agents/${worker.id}/start`, 'POST')
  try {
    await expect.poll(() => reached, { timeout: 10000 }).toBe(true)
    expect((await f.post('/api/team/dismiss', { worker_id: worker.id })).status).toBe(200)
  } finally {
    release()
  }
  expect((await start).status).toBe(409)
  expect(f.server.store.getActiveRunByAgentId(f.workspace.id, worker.id)).toBeUndefined()
  expect(existsSync(join(f.root, `${worker.id}.runtime`))).toBe(false)
  expect(f.server.store.getAgent(f.workspace.id, worker.id)).toMatchObject({
    status: 'stopped',
    retiredAt: expect.any(Number),
  })
}, 60000)

test('preset model and role reuse do not transfer the Orchestrator execution grant', async () => {
  const f = await setup()
  const response = await f.ui(f.policyPath, 'PUT', {
    enabled: true,
    allowed_command_preset_ids: ['codex'],
    max_ephemeral_workers: 2,
  })
  expect(response.status).toBe(200)
  const created = await f.create('Model worker', {
    command_preset_id: 'codex',
    model: 'fixture-model',
    role: 'reviewer',
  })
  expect(created.status).toBe(201)
  const worker = (await created.json()) as Created
  expect(worker).toMatchObject({
    role: 'reviewer',
    command_preset_id: 'codex',
    agent_start: { ok: false, error: null, run_id: null },
  })
  expect(f.server.store.peekAgentLaunchConfig(f.workspace.id, worker.id)).toMatchObject({
    commandPresetId: 'codex',
    args: expect.arrayContaining(['--model', 'fixture-model']),
  })
  expect(f.server.store.getWorker(f.workspace.id, worker.id).description).toContain('Reviewer')
  const controller = await f.server.store.executionPolicies.preview(f.workspace.id, f.actor)
  expect(controller.unsafe_grant).not.toBeNull()
  const policy = await f.server.store.executionPolicies.preview(f.workspace.id, worker.id)
  expect(policy).toMatchObject({ profile: 'restricted', unsafe_grant: null })
}, 60000)
