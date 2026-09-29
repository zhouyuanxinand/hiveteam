import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { inspectDataBackup } from '../../src/server/data-backup.js'
import { restoreDataBackup } from '../../src/server/data-restore.js'
import { authorizeSyntheticAgent } from '../helpers/authorized-runtime.js'
import { startAuthorizedTestServer, startTestServer } from '../helpers/test-server.js'

let server: Awaited<ReturnType<typeof startAuthorizedTestServer>>
let root: string
let workspaceId: string
let actor: string
let presetId: string
const received = (id: string) => readFileSync(join(root, `${id}.txt`), 'utf8')
const startMain = async () => {
  server.store.configureAgentLaunch(workspaceId, actor, {
    command: process.execPath,
    args: [join(root, 'member.mjs')],
    commandPresetId: presetId,
  })
  await server.store.startAgent(workspaceId, actor, { hivePort: new URL(server.baseUrl).port })
  await expect
    .poll(() => server.store.getActiveRunByAgentId(workspaceId, actor)?.output, { timeout: 15000 })
    .toContain('READY')
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hive-auto-grill-'))
  mkdirSync(join(root, 'workspace'))
  mkdirSync(join(root, 'pack/grilling'), { recursive: true })
  writeFileSync(
    join(root, 'pack/grilling/SKILL.md'),
    '---\nname: grilling\ndescription: Interview requirements\n---\nPINNED-INTERVIEW-BODY'
  )
  writeFileSync(
    join(root, 'member.mjs'),
    `import {appendFileSync,writeFileSync} from 'node:fs';
const file=${JSON.stringify(root)}+'/'+process.env.HIVE_AGENT_ID.replaceAll(':','_')+'.txt';
writeFileSync(file,''); if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.on('data',data=>{appendFileSync(file,data);process.stdout.write(data)});
console.log('READY');setInterval(()=>{},1000);`
  )
  server = await startAuthorizedTestServer({ dataDir: join(root, 'data') })
  workspaceId = server.store.createWorkspace(join(root, 'workspace'), '访谈').id
  actor = `${workspaceId}:orchestrator`
  presetId = server.store.settings.createCommandPreset({
    command: process.execPath,
    args: [join(root, 'member.mjs')],
    displayName: 'Interview fixture',
    env: {},
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: null,
  }).id
  const release = await server.store.skills.resolvePack({
    packName: 'matt',
    source: { type: 'local', path: join(root, 'pack') },
  })
  const plan = await server.store.skills.plan(workspaceId, {
    action: 'bind',
    packName: 'matt',
    releaseId: release.id,
    nativeExposure: [],
    profiles: { orchestrator: ['grilling'], custom: [] },
  })
  await server.store.skills.applyPlan(workspaceId, plan.id)
  await startMain()
})
afterEach(async () => {
  await server?.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const body = (extra: object = {}) => ({
  request_id: randomUUID(),
  text: 'Clarify the mail plan',
  skill_name: 'matt/grilling',
  ...extra,
})
const post = (input: object, extra: object = {}) =>
  fetch(`${server.baseUrl}/api/team/grill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...input,
      project_id: workspaceId,
      from_agent_id: actor,
      token: server.store.peekAgentToken(actor),
      ...extra,
    }),
  })
const request = async (input = body()) => {
  const response = await post(input)
  expect(response.status, await response.clone().text()).toBe(202)
  return response.json()
}

test('empty team creates a role-named member and durably delivers its pinned interview once', async () => {
  expect(server.store.workerLifecycle.readPolicy(workspaceId).enabled).toBe(false)
  const input = body()
  const [result, duplicate] = await Promise.all([request(input), request(input)])
  expect(result).toMatchObject({
    ok: true,
    request_id: input.request_id,
    worker_name: '需求访谈员',
    created: true,
    status: 'submitted',
  })
  expect(duplicate).toEqual(result)
  expect(server.store.listWorkers(workspaceId)).toHaveLength(1)
  expect(server.store.peekAgentLaunchConfig(workspaceId, result.worker_id)?.commandPresetId).toBe(
    presetId
  )
  await expect
    .poll(() => server.store.getActiveRunByAgentId(workspaceId, result.worker_id)?.output, {
      timeout: 15000,
    })
    .toContain('READY')
  await expect
    .poll(() => received(result.worker_id), { timeout: 15000 })
    .toContain('PINNED-INTERVIEW-BODY')
  expect(received(result.worker_id)).toContain(input.text)
  expect(received(actor.replaceAll(':', '_'))).not.toContain('PINNED-INTERVIEW-BODY')
  expect(server.store.getWorker(workspaceId, result.worker_id).pendingTaskCount).toBe(1)
  expect((await post({ ...input, text: 'different' })).status).toBe(409)
  expect(server.store.workerLifecycle.readPolicy(workspaceId).enabled).toBe(false)
  await server.close()
  server = await startAuthorizedTestServer({ dataDir: join(root, 'data') })
  await startMain()
  const restored = await request(input)
  expect(restored).toMatchObject({ worker_id: result.worker_id, dispatch_id: result.dispatch_id })
  expect(server.store.listWorkers(workspaceId)).toHaveLength(1)
}, 45000)

test('authentication and skill failures never create a member', async () => {
  expect((await post(body(), { token: 'invalid' })).status).toBe(401)
  expect((await post(body({ skill_name: 'matt/tdd' }))).status).toBe(400)
  expect((await post(body({ skill_name: 'unknown/grilling' }))).status).toBe(403)
  expect(server.store.listWorkers(workspaceId)).toHaveLength(0)
})

test('reuses a finished interviewer, leaves busy interviews alone and enforces the member limit', async () => {
  const first = await request()
  const second = await request(body({ text: 'Second interview' }))
  expect(second.worker_id).not.toBe(first.worker_id)
  expect(second.worker_name).toBe('需求访谈员 2')
  expect((await post(body({ text: 'Over limit' }))).status).toBe(409)
  expect(server.store.listWorkers(workspaceId)).toHaveLength(2)
  server.store.reportTask(workspaceId, first.worker_id, {
    dispatchId: first.dispatch_id,
    text: 'Confirmed final scope',
    outcome: 'success',
  })
  const reused = await request(body({ text: 'Next interview' }))
  expect(reused).toMatchObject({ ok: true, worker_id: first.worker_id, created: false })
  expect(server.store.getDispatch(workspaceId, second.dispatch_id)?.status).toBe('submitted')
  expect(server.store.listWorkers(workspaceId)).toHaveLength(2)
}, 45000)

test('resource admission queues the durable task and delivers it after capacity returns', async () => {
  server.store.resources.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
  const input = body()
  const result = await request(input)
  expect(result).toMatchObject({ ok: true, status: 'queued' })
  expect(server.store.getActiveRunByAgentId(workspaceId, result.worker_id)).toBeUndefined()
  expect(server.store.resourceQueue.list(workspaceId)).toContainEqual(
    expect.objectContaining({
      agent_id: result.worker_id,
      status: 'queued',
      source: 'dispatch',
    })
  )
  server.store.resources.updateLimits({ max_running_total: 2 }, { actor: 'local_user' })
  await expect
    .poll(() => server.store.getDispatch(workspaceId, result.dispatch_id)?.status, {
      timeout: 15000,
    })
    .toBe('submitted')
  await expect.poll(() => received(result.worker_id), { timeout: 15000 }).toContain(input.text)
  expect((await request(input)).dispatch_id).toBe(result.dispatch_id)
  expect(received(result.worker_id).split(input.text)).toHaveLength(2)
}, 45000)

test('execution approval is not copied; the same blocked task resumes after an explicit grant', async () => {
  await server.close()
  server = await startTestServer({ dataDir: join(root, 'data') })
  await authorizeSyntheticAgent(server.store, workspaceId, actor)
  await startMain()
  const input = body()
  const blocked = await request(input)
  expect(blocked).toMatchObject({ ok: false, status: 'failed' })
  expect(blocked.error).toEqual(expect.any(String))
  expect(server.store.getActiveRunByAgentId(workspaceId, blocked.worker_id)).toBeUndefined()
  expect(server.store.getDispatch(workspaceId, blocked.dispatch_id)?.status).toBe('failed')
  expect(await request(input)).toEqual(blocked)
  expect(server.store.listWorkers(workspaceId)).toHaveLength(1)
  await authorizeSyntheticAgent(server.store, workspaceId, blocked.worker_id)
  await server.store.startAgent(workspaceId, blocked.worker_id, {
    hivePort: new URL(server.baseUrl).port,
  })
  await expect
    .poll(() => server.store.getDispatch(workspaceId, blocked.dispatch_id)?.status, {
      timeout: 15000,
    })
    .toBe('submitted')
  await expect.poll(() => received(blocked.worker_id), { timeout: 15000 }).toContain(input.text)
  expect(await request(input)).toMatchObject({ ok: true, dispatch_id: blocked.dispatch_id })
}, 45000)

test('configured preset restrictions roll back admission and members cannot recursively create interviewers', async () => {
  server.store.workerLifecycle.updatePolicy(workspaceId, {
    enabled: true,
    allowed_command_preset_ids: ['codex'],
    max_ephemeral_workers: 2,
  })
  expect((await post(body())).status).toBe(403)
  expect(server.store.listWorkers(workspaceId)).toHaveLength(0)
  server.store.workerLifecycle.updatePolicy(workspaceId, {
    enabled: false,
    allowed_command_preset_ids: [],
    max_ephemeral_workers: 2,
  })
  const first = await request()
  expect(
    (
      await post(body(), {
        from_agent_id: first.worker_id,
        token: server.store.peekAgentToken(first.worker_id),
      })
    ).status
  ).toBe(403)
  expect(server.store.listWorkers(workspaceId)).toHaveLength(1)
})

test('backup and restore retain request ownership so a retry cannot duplicate the handoff', async () => {
  const input = body()
  const original = await request(input)
  const backup = join(root, 'backup')
  await server.store.createBackup(backup)
  const preview = await inspectDataBackup(backup)
  const target = join(root, 'restored')
  await restoreDataBackup({
    directory: backup,
    target,
    manifestVersion: preview.manifest_version,
    workspaceBindings: { [workspaceId]: join(root, 'workspace') },
    confirm: true,
  })
  await server.close()
  server = await startAuthorizedTestServer({ dataDir: target })
  // Restore deliberately requires a fresh CLI binding and execution authorization.
  server.store.configureAgentLaunch(workspaceId, actor, {
    command: process.execPath,
    args: [join(root, 'member.mjs')],
  })
  await server.store.startAgent(workspaceId, actor, { hivePort: new URL(server.baseUrl).port })
  const restored = await request(input)
  expect(restored).toMatchObject({
    request_id: input.request_id,
    worker_id: original.worker_id,
    dispatch_id: original.dispatch_id,
  })
  expect(server.store.listWorkers(workspaceId)).toHaveLength(1)
}, 45000)
