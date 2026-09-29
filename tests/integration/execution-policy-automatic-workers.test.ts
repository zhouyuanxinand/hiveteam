import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'
import type { ExecutionPolicyView } from '../../src/shared/execution-policy.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

let server: Awaited<ReturnType<typeof startTestServer>>
let root: string
let workspaceId: string
let actor: string
let presetId: string
let cookie: string
const path = (id = actor) => `/api/ui/workspaces/${workspaceId}/agents/${id}/execution-policy`
const get = async (id = actor): Promise<ExecutionPolicyView> => {
  const response = await fetch(server.baseUrl + path(id), { headers: { cookie } })
  expect(response.status).toBe(200)
  return response.json()
}
const update = async (extra: object, id = actor) => {
  const policy = await get(id)
  return fetch(server.baseUrl + path(id), {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      profile: 'trusted_unsafe',
      expected_cli_fingerprint: policy.cli_fingerprint,
      expected_cli_version: policy.cli_version,
      policy_revision: policy.policy_revision,
      acknowledge_unsafe: true,
      ...extra,
    }),
  })
}
const setupWorkspace = async () => {
  const directory = join(root, randomUUID())
  mkdirSync(directory)
  workspaceId = server.store.createWorkspace(directory, 'Automatic trust').id
  actor = `${workspaceId}:orchestrator`
  server.store.configureAgentLaunch(workspaceId, actor, {
    command: process.execPath,
    args: [join(root, 'member.mjs')],
    commandPresetId: presetId,
  })
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
  expect((await update({})).status).toBe(200)
  await server.store.startAgent(workspaceId, actor, { hivePort: new URL(server.baseUrl).port })
}
const grill = async () => {
  const response = await fetch(`${server.baseUrl}/api/team/grill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: workspaceId,
      from_agent_id: actor,
      token: server.store.peekAgentToken(actor),
      request_id: randomUUID(),
      text: 'Interview fixture',
      skill_name: 'matt/grilling',
    }),
  })
  expect(response.status, await response.clone().text()).toBe(202)
  return response.json()
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hive-automatic-trust-'))
  mkdirSync(join(root, 'pack/grilling'), { recursive: true })
  writeFileSync(
    join(root, 'pack/grilling/SKILL.md'),
    '---\nname: grilling\ndescription: Interview\n---\nPINNED-AUTOMATIC-INTERVIEW'
  )
  writeFileSync(
    join(root, 'member.mjs'),
    `import {appendFileSync,writeFileSync} from 'node:fs';
const file=${JSON.stringify(root)}+'/'+process.env.HIVE_AGENT_ID.replaceAll(':','_')+'.txt';
writeFileSync(file,'');if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.on('data',data=>{appendFileSync(file,data);process.stdout.write(data)});
console.log('READY');setInterval(()=>{},1000);`
  )
  server = await startTestServer({ dataDir: join(root, 'data') })
  cookie = await getUiCookie(server.baseUrl)
  presetId = server.store.settings.createCommandPreset({
    command: process.execPath,
    args: [join(root, 'member.mjs')],
    displayName: 'Automatic fixture',
    env: {},
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: null,
  }).id
  await setupWorkspace()
})
afterEach(async () => {
  await server?.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('only an explicit local default authorizes newly created interviewers and survives restart and new workspaces', async () => {
  const blocked = await grill()
  expect(blocked).toMatchObject({ ok: false, status: 'failed' })
  expect(await get(blocked.worker_id)).toMatchObject({
    profile: 'restricted',
    trust_automatic_workers: false,
    automatic_worker: true,
  })
  expect((await update({ trust_automatic_workers: true })).status).toBe(200)
  const allowed = await grill()
  expect(allowed).toMatchObject({ ok: true, status: 'submitted', created: true })
  expect(await get(allowed.worker_id)).toMatchObject({
    profile: 'trusted_unsafe',
    trust_automatic_workers: true,
    automatic_worker: true,
  })
  await expect
    .poll(() => readFileSync(join(root, `${allowed.worker_id}.txt`), 'utf8'), { timeout: 15000 })
    .toContain('PINNED-AUTOMATIC-INTERVIEW')
  expect((await get(blocked.worker_id)).profile).toBe('restricted')
  await server.close()
  server = await startTestServer({ dataDir: join(root, 'data') })
  cookie = await getUiCookie(server.baseUrl)
  await setupWorkspace()
  expect((await get()).trust_automatic_workers).toBe(true)
  expect(await grill()).toMatchObject({ ok: true, status: 'submitted' })
  const db = new Database(join(root, 'data/runtime.sqlite'), { readonly: true })
  try {
    expect(
      db
        .prepare(
          "SELECT actor FROM execution_policy_events WHERE action = 'trust_automatic_workers'"
        )
        .all()
    ).toEqual([{ actor: 'local_user' }])
    expect(
      db
        .prepare(
          "SELECT actor FROM execution_policy_events WHERE action = 'grant_automatic_worker'"
        )
        .all()
    ).toHaveLength(2)
  } finally {
    db.close()
  }
}, 60000)

test('disabling the default preserves the current grant; manual members and revoked workers stay restricted', async () => {
  expect((await update({ trust_automatic_workers: true })).status).toBe(200)
  const manual = server.store.addWorker(workspaceId, { name: 'Manual', role: 'custom' })
  server.store.configureAgentLaunch(workspaceId, manual.id, {
    command: process.execPath,
    args: [join(root, 'member.mjs')],
    commandPresetId: presetId,
  })
  expect(await get(manual.id)).toMatchObject({
    profile: 'restricted',
    automatic_worker: false,
    trust_automatic_workers: true,
  })
  const allowed = await grill()
  const run = server.store.getActiveRunByAgentId(workspaceId, allowed.worker_id)
  expect(run).toBeDefined()
  const revoke = await fetch(server.baseUrl + path(allowed.worker_id), {
    method: 'DELETE',
    headers: { cookie },
  })
  expect(revoke.status).toBe(200)
  if (run) server.store.stopAgentRun(run.runId)
  await expect
    .poll(() => server.store.resources.getSnapshot().occupancy.global, { timeout: 15000 })
    .toBe(1)
  await expect(
    server.store.startAgent(workspaceId, allowed.worker_id, {
      hivePort: new URL(server.baseUrl).port,
    })
  ).rejects.toMatchObject({ code: 'execution_policy_denied' })
  expect((await get(allowed.worker_id)).profile).toBe('restricted')
  expect((await update({ trust_automatic_workers: false })).status).toBe(200)
  expect(await get()).toMatchObject({ profile: 'trusted_unsafe', trust_automatic_workers: false })
  expect(await grill()).toMatchObject({ ok: false, status: 'failed' })
}, 45000)

test('changing launcher bytes invalidates the installation default without executing it', async () => {
  const command = join(root, process.platform === 'win32' ? 'fixture.cmd' : 'fixture.sh')
  writeFileSync(
    command,
    process.platform === 'win32' ? '@echo first\r\n' : '#!/bin/sh\necho first\n',
    { mode: 0o700 }
  )
  const preset = server.store.settings.getCommandPreset(presetId)
  if (!preset) throw new Error('Missing fixture preset')
  server.store.settings.updateCommandPreset(presetId, { ...preset, command, args: [] })
  server.store.configureAgentLaunch(workspaceId, actor, { command, commandPresetId: presetId })
  expect((await update({ trust_automatic_workers: true })).status).toBe(200)
  expect((await get()).trust_automatic_workers).toBe(true)
  writeFileSync(
    command,
    process.platform === 'win32' ? '@echo second\r\n' : '#!/bin/sh\necho second\n',
    { mode: 0o700 }
  )
  expect(await get()).toMatchObject({ trust_automatic_workers: false, profile: 'restricted' })
  expect(await grill()).toMatchObject({ ok: false, status: 'failed' })
}, 45000)

test('a failed preference audit cannot persist either a default or a member grant', async () => {
  expect(
    (await fetch(server.baseUrl + path(), { method: 'DELETE', headers: { cookie } })).status
  ).toBe(200)
  const db = new Database(join(root, 'data/runtime.sqlite'))
  try {
    db.exec(`CREATE TRIGGER fail_automatic_trust_audit BEFORE INSERT ON execution_policy_events
      WHEN NEW.action = 'trust_automatic_workers' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`)
    expect((await update({ trust_automatic_workers: true })).status).toBe(500)
    expect(await get()).toMatchObject({ trust_automatic_workers: false, profile: 'restricted' })
    expect(db.prepare('SELECT count(*) AS count FROM execution_unsafe_grants').get()).toEqual({
      count: 0,
    })
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM app_state WHERE key LIKE 'execution:automatic-worker-trust:%'"
        )
        .get()
    ).toEqual({ count: 0 })
  } finally {
    db.close()
  }
})

test('an explicit disabled default stays configured after revocation and platform restart', async () => {
  expect(await get()).toMatchObject({
    trust_automatic_workers: false,
    automatic_worker_trust_configured: false,
  })
  expect((await update({ trust_automatic_workers: false })).status).toBe(200)
  expect(
    (await fetch(server.baseUrl + path(), { method: 'DELETE', headers: { cookie } })).status
  ).toBe(200)
  expect(await get()).toMatchObject({
    profile: 'restricted',
    trust_automatic_workers: false,
    automatic_worker_trust_configured: true,
  })
  await server.close()
  server = await startTestServer({ dataDir: join(root, 'data') })
  cookie = await getUiCookie(server.baseUrl)
  expect(await get()).toMatchObject({
    profile: 'restricted',
    trust_automatic_workers: false,
    automatic_worker_trust_configured: true,
  })
}, 45000)

test('default changes require local acknowledgement and current identity; preset changes invalidate remembered trust', async () => {
  expect((await update({ trust_automatic_workers: true, acknowledge_unsafe: false })).status).toBe(
    400
  )
  expect(
    (await update({ trust_automatic_workers: true, expected_cli_fingerprint: 'stale' })).status
  ).toBe(409)
  const forged = await fetch(server.baseUrl + path(), {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-hive-agent-id': actor,
      'x-hive-agent-token': server.store.peekAgentToken(actor) ?? '',
    },
    body: JSON.stringify({ trust_automatic_workers: true }),
  })
  expect(forged.status).toBe(403)
  expect((await update({ trust_automatic_workers: true })).status).toBe(200)
  const appState = await fetch(
    `${server.baseUrl}/api/settings/app-state/execution:automatic-worker-trust:${presetId}`,
    {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: '{}' }),
    }
  )
  expect(appState.status).toBe(403)
  const preset = server.store.settings.getCommandPreset(presetId)
  if (!preset) throw new Error('Missing fixture preset')
  server.store.settings.updateCommandPreset(presetId, {
    ...preset,
    env: { AUTOMATIC_FIXTURE_CHANGED: '1' },
  })
  expect((await get()).trust_automatic_workers).toBe(false)
  expect(await grill()).toMatchObject({ ok: false, status: 'failed' })
}, 45000)
