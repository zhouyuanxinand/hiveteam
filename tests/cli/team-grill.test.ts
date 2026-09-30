import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createTeamMailboxBroker } from '../../src/server/team-mailbox-broker.js'
import { authorizeSyntheticAgent } from '../helpers/authorized-runtime.js'
import { startAuthorizedTestServer, startTestServer } from '../helpers/test-server.js'

const brokers: Awaited<ReturnType<typeof createTeamMailboxBroker>>[] = []
const servers: Awaited<ReturnType<typeof startAuthorizedTestServer>>[] = []
afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.close()
  for (const server of servers.splice(0)) await server.close()
})
const fixture = async (authorizeMembers = true) => {
  const server = await (authorizeMembers ? startAuthorizedTestServer() : startTestServer())
  servers.push(server)
  const project = join(server.dataDir, 'project'),
    pack = join(server.dataDir, 'pack')
  mkdirSync(project)
  mkdirSync(join(pack, 'grilling'), { recursive: true })
  writeFileSync(
    join(pack, 'grilling', 'SKILL.md'),
    '---\nname: grilling\ndescription: Interview fixture\n---\nASK ONLY IN THE MEMBER WINDOW'
  )
  const workspace = server.store.createWorkspace(project, 'Grill CLI')
  const actor = `${workspace.id}:orchestrator`
  const config = {
    command: process.execPath,
    args: [
      '-e',
      'if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.on("data",()=>{});console.log("GRILL_READY")',
    ],
  }
  const preset = server.store.settings.createCommandPreset({
    ...config,
    displayName: 'Grill fixture',
    env: {},
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: null,
  })
  server.store.configureAgentLaunch(workspace.id, actor, { ...config, commandPresetId: preset.id })
  const release = await server.store.skills.resolvePack({
    packName: 'fixture',
    source: { type: 'local', path: pack },
  })
  const plan = await server.store.skills.plan(workspace.id, {
    action: 'bind',
    packName: 'fixture',
    releaseId: release.id,
    nativeExposure: [],
    profiles: { orchestrator: ['grilling'] },
  })
  await server.store.skills.applyPlan(workspace.id, plan.id)
  if (!authorizeMembers) await authorizeSyntheticAgent(server.store, workspace.id, actor)
  await server.store.startAgent(workspace.id, actor, { hivePort: new URL(server.baseUrl).port })
  const cli = (args: string[], token = server.store.peekAgentToken(actor), mailbox = '') =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'bin/team', ...args], {
        windowsHide: true,
        timeout: 30000,
        env: {
          ...process.env,
          HIVE_TEAM_MAILBOX: mailbox,
          HIVE_PROJECT_ID: workspace.id,
          HIVE_AGENT_ID: actor,
          HIVE_AGENT_TOKEN: token,
          HIVE_PORT: new URL(server.baseUrl).port,
        },
      })
      let stdout = '',
        stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })
  return { server, workspace, actor, cli }
}

test('real grill CLI creates a member, returns its dispatch and reuses the printed request ID on retry', async () => {
  const f = await fixture()
  const args = ['grill', 'Clarify goals and acceptance', '--skill', 'fixture/grilling']
  const first = await f.cli(args)
  expect(first.code, first.stderr).toBe(0)
  const result = JSON.parse(first.stdout)
  expect(result).toMatchObject({ ok: true, created: true })
  expect(result.request_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  )
  expect(first.stderr).toContain(result.request_id)
  expect(f.server.store.listWorkers(f.workspace.id)).toHaveLength(1)
  expect(f.server.store.getDispatch(f.workspace.id, result.dispatch_id)?.toAgentId).toBe(
    result.worker_id
  )
  const retry = await f.cli([...args, '--request-id', result.request_id])
  expect(retry.code, retry.stderr).toBe(0)
  expect(JSON.parse(retry.stdout)).toMatchObject({
    request_id: result.request_id,
    worker_id: result.worker_id,
    dispatch_id: result.dispatch_id,
  })
  expect(f.server.store.listWorkers(f.workspace.id)).toHaveLength(1)
}, 30000)

test('real grill CLI preserves authentication failures and validates retry IDs without creating members', async () => {
  const f = await fixture()
  const requestId = randomUUID()
  const args = [
    'grill',
    'Clarify goals and acceptance',
    '--skill',
    'fixture/grilling',
    '--request-id',
    requestId,
  ]
  const denied = await f.cli(args, 'mailbox')
  expect(denied.code).toBe(1)
  expect(denied.stderr).toContain(requestId)
  expect(denied.stderr).toContain('401')
  expect(denied.stderr).toContain('Invalid or missing agent token')
  expect(denied.stderr).toContain('Restart the Orchestrator from HiveTeam')
  expect(denied.stderr).toContain('Do not conduct the interview in the main thread')
  expect(denied.stdout).toBe('')
  expect(f.server.store.listWorkers(f.workspace.id)).toHaveLength(0)

  const invalid = await f.cli([...args.slice(0, -1), 'not-a-uuid'])
  expect(invalid.code).toBe(1)
  expect(invalid.stderr).toContain('team grill')
  expect(invalid.stdout).toBe('')
  expect(f.server.store.listWorkers(f.workspace.id)).toHaveLength(0)
}, 30000)

test('real grill CLI hands off through the scoped mailbox without receiving its agent credential', async () => {
  const f = await fixture()
  const token = f.server.store.peekAgentToken(f.actor)
  if (!token) throw new Error('Expected active fixture credential')
  const broker = await createTeamMailboxBroker({
    root: join(f.server.dataDir, 'mailbox'),
    workspaceId: f.workspace.id,
    agentId: f.actor,
    token,
    hivePort: new URL(f.server.baseUrl).port,
    isActive: () => f.server.store.validateAgentToken(f.actor, token),
  })
  brokers.push(broker)
  const result = await f.cli(
    ['grill', 'Clarify through the mailbox', '--skill', 'fixture/grilling'],
    'mailbox',
    broker.path
  )
  expect(result.code, result.stderr).toBe(0)
  const response = JSON.parse(result.stdout)
  expect(response).toMatchObject({ ok: true, created: true, status: 'submitted' })
  expect(f.server.store.getDispatch(f.workspace.id, response.dispatch_id)?.toAgentId).toBe(
    response.worker_id
  )
  expect(result.stdout).not.toContain(token)
  expect(result.stderr).not.toContain(token)
  expect(f.server.store.listWorkers(f.workspace.id)).toHaveLength(1)
}, 30000)

test('real grill CLI exits nonzero for a persisted authorization failure and retains the same handoff on retry', async () => {
  const f = await fixture(false)
  const args = ['grill', 'Clarify after approval', '--skill', 'fixture/grilling']
  const blocked = await f.cli(args)
  expect(blocked.code).toBe(1)
  const response = JSON.parse(blocked.stdout)
  expect(response).toMatchObject({ ok: false, created: true, status: 'failed' })
  expect(response.error).toEqual(expect.any(String))
  expect(blocked.stderr).toContain(`--request-id ${response.request_id}`)
  expect(f.server.store.getDispatch(f.workspace.id, response.dispatch_id)?.status).toBe('failed')
  expect(f.server.store.getActiveRunByAgentId(f.workspace.id, response.worker_id)).toBeUndefined()
  const retried = await f.cli([...args, '--request-id', response.request_id])
  expect(retried.code).toBe(1)
  expect(JSON.parse(retried.stdout)).toEqual(response)
  expect(f.server.store.listWorkers(f.workspace.id)).toHaveLength(1)
}, 30000)
