import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import * as nativeProfiles from '../../src/server/native-backup-profile.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import Database from '../../src/server/sqlite.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-backup-fixture-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const server = await startTestServer({ dataDir: join(root, 'data') })
  cleanup.push(server.close)
  const path = join(root, '项目 中文')
  mkdirSync(path)
  const workspace = server.store.createWorkspace(path, 'Backup')
  const cookie = await getUiCookie(server.baseUrl)
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  cleanup.push(() => {
    db.close()
  })
  const call = (route: string, body: unknown, auth = cookie) =>
    fetch(server.baseUrl + route, {
      method: 'POST',
      headers: { cookie: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { ...server, root, path, workspace, cookie, db, call }
}
test('WAL backup exports a fresh sanitized database, validates attachments, and restores stopped identities to explicit bindings', async () => {
  const f = await fixture()
  const worker = f.store.addWorker(f.workspace.id, { name: 'Alice', role: 'coder' })
  const dispatch = await f.store.dispatchTask(f.workspace.id, worker.id, 'Preserve history')
  f.store.reportTask(f.workspace.id, worker.id, {
    dispatchId: dispatch.id,
    requireActiveRun: true,
    outcome: 'success',
    text: 'Natural language may contain private data',
    artifacts: ['external-source.ts'],
  })
  const receipt = f.db
    .prepare('SELECT receipt_id FROM report_outbox WHERE dispatch_id=?')
    .get(dispatch.id)
  const secret = `synthetic-structured-${randomUUID()}`
  f.store.settings.internalAppState.set('remote_daemon_token', secret)
  f.store.settings.createCommandPreset({
    displayName: 'Fixture',
    command: process.execPath,
    args: ['--api-key', secret],
    env: { API_KEY: secret },
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: [],
  })
  f.db
    .prepare(
      'INSERT INTO remote_devices(id,name,created_at,d2p_key,p2d_key,device_public_key) VALUES(?,?,?,?,?,?)'
    )
    .run(
      randomUUID(),
      'synthetic',
      Date.now(),
      Buffer.from(secret),
      Buffer.from(secret),
      Buffer.from(secret)
    )
  const verification = randomUUID(),
    log = Buffer.from('Synthetic verification output\n')
  f.db
    .prepare(
      "INSERT INTO dispatch_verifications(id,workspace_id,dispatch_id,report_revision,head_sha,command,state,output,started_at,log_bytes) VALUES(?,?,?,?,?,?,'passed','',?,?)"
    )
    .run(
      verification,
      f.workspace.id,
      dispatch.id,
      1,
      'fixture-sha',
      'fixture',
      Date.now(),
      log.length
    )
  mkdirSync(join(f.dataDir, 'verification-logs'))
  writeFileSync(join(f.dataDir, 'verification-logs', `${verification}.log`), log)
  const interruptedRun = randomUUID()
  f.db
    .prepare(`INSERT INTO workflow_runs(id,workspace_id,workflow_id,name,definition_json,steps_json,hive_port,status,error,created_at,started_at,updated_at)
    VALUES(?,?,?,'Interrupted backup fixture','{"name":"Backup","steps":[]}','[]','','interrupted','Uncertain original delivery',?,?,?)`)
    .run(interruptedRun, f.workspace.id, 'backup.json', Date.now(), Date.now(), Date.now())
  const output = join(f.root, 'backup')
  // Real concurrent source commits while SQLite's backup API owns snapshot consistency.
  const writing = setInterval(
    () => f.store.settings.internalAppState.set('fixture_counter', String(Date.now())),
    1
  )
  let response: Response
  try {
    response = await f.call('/api/settings/backups', { output })
  } finally {
    clearInterval(writing)
  }
  expect(response.status, await response.clone().text()).toBe(201)
  const created = await response.json()
  expect(created.manifest).toMatchObject({
    cleanup: 'raw_snapshot_removed',
    credentials: 'excluded_requires_new_authentication_and_pairing',
    external_references: expect.arrayContaining([
      { kind: 'reported_artifact', reference: 'external-source.ts', included: false },
    ]),
  })
  expect(readFileSync(join(output, 'runtime.sqlite')).includes(Buffer.from(secret))).toBe(false)
  expect(readFileSync(join(output, 'manifest.json'), 'utf8')).not.toContain(secret)
  expect(
    readdirSync(f.root).filter(
      (name) => name.startsWith('.hive-raw') || name.startsWith('.hive-backup')
    )
  ).toEqual([])
  expect(f.store.settings.internalAppState.get('remote_daemon_token')?.value).toBe(secret)
  const inspection = await f.call('/api/settings/backups/inspect', { directory: output })
  expect(inspection.status).toBe(200)
  const preview = await inspection.json()
  const target = join(f.root, 'restored'),
    project = join(f.root, 'new 项目')
  mkdirSync(project)
  const auth = join(f.root, 'target-cli-auth.json')
  writeFileSync(auth, 'existing target authentication')
  const restored = await f.call('/api/settings/backups/restore', {
    directory: output,
    target,
    manifest_version: preview.manifest_version,
    workspace_bindings: { [f.workspace.id]: project },
    confirm: true,
  })
  expect(restored.status, await restored.clone().text()).toBe(201)
  expect(readFileSync(auth, 'utf8')).toBe('existing target authentication')
  expect(existsSync(join(f.dataDir, 'runtime.sqlite'))).toBe(true)
  const db = new Database(join(target, 'runtime.sqlite'))
  try {
    expect(
      db.prepare('SELECT receipt_id FROM report_outbox WHERE dispatch_id=?').get(dispatch.id)
    ).toEqual(receipt)
    expect(
      db.prepare('SELECT status,error FROM workflow_runs WHERE id=?').get(interruptedRun)
    ).toEqual({
      status: 'failed',
      error: 'Restored: manual reconciliation required',
    })
    expect(db.prepare('SELECT * FROM remote_devices').all()).toEqual([])
    expect(db.prepare('SELECT * FROM execution_unsafe_grants').all()).toEqual([])
    expect(db.prepare('SELECT * FROM agent_launch_configs').all()).toEqual([])
    expect(db.prepare('SELECT * FROM report_outbox WHERE delivered_at IS NULL').all()).toHaveLength(
      1
    )
  } finally {
    db.close()
  }
  const runtime = createRuntimeStore({ dataDir: target })
  try {
    expect(runtime.getWorkspaceSnapshot(f.workspace.id).summary.path).toBe(project)
    expect(
      runtime
        .getWorkspaceSnapshot(f.workspace.id)
        .agents.every((agent) => agent.status === 'stopped')
    ).toBe(true)
    expect(runtime.listTerminalRuns(f.workspace.id)).toEqual([])
    await runtime.workflows.refresh(f.workspace.id, interruptedRun)
    expect(runtime.workflows.get(f.workspace.id, interruptedRun)?.status).toBe('failed')
  } finally {
    await runtime.close()
  }
})

test('missing attachments, modified packages and traversal are rejected without publishing or replacing data', async () => {
  const f = await fixture(),
    output = join(f.root, 'good')
  expect((await f.call('/api/settings/backups', { output }, '')).status).toBe(403)
  expect((await f.call('/api/settings/backups', { output })).status).toBe(201)
  const manifestPath = join(output, 'manifest.json'),
    original = readFileSync(manifestPath, 'utf8'),
    manifest = JSON.parse(original)
  manifest.attachments = [
    { path: 'attachments/../../outside', target: null, bytes: 0, sha256: '0'.repeat(64) },
  ]
  writeFileSync(manifestPath, JSON.stringify(manifest))
  expect((await f.call('/api/settings/backups/inspect', { directory: output })).status).toBe(400)
  writeFileSync(manifestPath, original)
  const originalDatabase = readFileSync(join(output, 'runtime.sqlite'))
  writeFileSync(
    join(output, 'runtime.sqlite'),
    Buffer.concat([originalDatabase, Buffer.from('tampered')])
  )
  expect((await f.call('/api/settings/backups/inspect', { directory: output })).status).toBe(400)
  writeFileSync(join(output, 'runtime.sqlite'), originalDatabase)
  const preview = await (
    await f.call('/api/settings/backups/inspect', { directory: output })
  ).json()
  expect(
    (
      await f.call('/api/settings/backups/restore', {
        directory: output,
        target: f.dataDir,
        manifest_version: preview.manifest_version,
        workspace_bindings: { [f.workspace.id]: f.path },
        confirm: true,
      })
    ).status
  ).toBe(409)
  const worker = f.store.addWorker(f.workspace.id, { name: 'Logs', role: 'tester' }),
    dispatch = await f.store.dispatchTask(f.workspace.id, worker.id, 'logs')
  f.db
    .prepare(
      "INSERT INTO dispatch_verifications(id,workspace_id,dispatch_id,report_revision,head_sha,command,state,output,started_at,log_bytes) VALUES(?,?,?,?,?,?,'passed','',?,?)"
    )
    .run(randomUUID(), f.workspace.id, dispatch.id, 1, 'sha', 'fixture', Date.now(), 10)
  const failed = join(f.root, 'failed')
  expect((await f.call('/api/settings/backups', { output: failed })).ok).toBe(false)
  expect(existsSync(failed)).toBe(false)
  expect(readdirSync(f.root).filter((name) => name.startsWith('.hive-'))).toEqual([])
})

test('optional native export requires an explicitly bound, quiescent, certified session profile', async () => {
  const f = await fixture(),
    generation = randomUUID(),
    nativeId = randomUUID()
  const sessionRoot = join(f.root, 'synthetic-native')
  mkdirSync(sessionRoot)
  writeFileSync(
    join(sessionRoot, 'session.json'),
    JSON.stringify({ id: nativeId, messages: ['synthetic only'] })
  )
  f.db
    .prepare(
      "INSERT INTO native_session_generations(id,workspace_id,agent_id,generation,harness,native_id,storage_root,context_json,state,current,reason,created_at,updated_at) VALUES(?,?,?,1,'grok',?,?,?,'bound',1,'fixture',?,?)"
    )
    .run(
      generation,
      f.workspace.id,
      `${f.workspace.id}:orchestrator`,
      nativeId,
      sessionRoot,
      '{}',
      Date.now(),
      Date.now()
    )
  const denied = await f.call('/api/settings/backups', {
    output: join(f.root, 'denied'),
    native_generations: [generation],
  })
  expect(denied.status).toBe(409)
  vi.spyOn(nativeProfiles, 'nativeBackupProfile').mockReturnValue({
    root: sessionRoot,
    files: ['session.json'],
    assertConsistent: async () => {
      const session = JSON.parse(readFileSync(join(sessionRoot, 'session.json'), 'utf8'))
      if (session.id !== nativeId) throw new Error('Session changed')
    },
  })
  const backup = await f.call('/api/settings/backups', {
    output: join(f.root, 'native-backup'),
    native_generations: [generation],
  })
  expect(backup.status, await backup.clone().text()).toBe(201)
  const result = await backup.json()
  expect(result.manifest.native_sessions).toEqual([
    expect.objectContaining({ native_id: nativeId, included: true }),
  ])
  expect(
    JSON.parse(readFileSync(join(result.path, 'native', generation, 'session.json'), 'utf8')).id
  ).toBe(nativeId)
})

test('backup validates every skill cache file against the persisted release digest', async () => {
  const f = await fixture()
  const source = join(f.root, 'pack'),
    skill = join(source, 'skills', 'fixture')
  mkdirSync(skill, { recursive: true })
  writeFileSync(
    join(skill, 'SKILL.md'),
    '---\nname: fixture\ndescription: Synthetic backup skill\n---\n# Fixture\nSynthetic instructions.\n'
  )
  writeFileSync(join(skill, 'reference.txt'), 'Synthetic reference')
  const resolved = await f.call(`/api/ui/workspaces/${f.workspace.id}/skill-packs/resolve`, {
    name: 'fixture',
    source: { type: 'local', path: source },
  })
  expect(resolved.status, await resolved.clone().text()).toBe(200)
  const output = join(f.root, 'skills-backup')
  expect((await f.call('/api/settings/backups', { output })).status).toBe(201)
  expect((await f.call('/api/settings/backups/inspect', { directory: output })).status).toBe(200)
  const manifestPath = join(output, 'manifest.json'),
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.attachments = manifest.attachments.filter(
    (member: { path: string }) => !member.path.endsWith('reference.txt')
  )
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const rejected = await f.call('/api/settings/backups/inspect', { directory: output })
  expect(rejected.status).toBe(400)
  expect((await rejected.json()).error).toContain('skill cache')
})

test('retention is an idempotent visibility archive; pending receipts and unresolved evidence remain protected', async () => {
  const f = await fixture(),
    worker = f.store.addWorker(f.workspace.id, { name: 'Alice', role: 'coder' })
  const done = await f.store.dispatchTask(f.workspace.id, worker.id, 'complete')
  f.store.reportTask(f.workspace.id, worker.id, {
    dispatchId: done.id,
    requireActiveRun: true,
    outcome: 'success',
    text: 'done',
    artifacts: [],
  })
  f.db.prepare('UPDATE dispatches SET accepted_at=? WHERE id=?').run(Date.now(), done.id)
  const pending = await f.store.dispatchTask(f.workspace.id, worker.id, 'pending')
  const url = `/api/ui/workspaces/${f.workspace.id}/retention`
  const read = async () => (await fetch(f.baseUrl + url, { headers: { cookie: f.cookie } })).json()
  let preview = await read()
  expect(
    preview.records.find((r: { dispatch_id: string }) => r.dispatch_id === done.id).reasons
  ).toContain('report_delivery_not_confirmed')
  f.db
    .prepare('UPDATE report_outbox SET delivered_at=? WHERE dispatch_id=?')
    .run(Date.now(), done.id)
  f.db.prepare("UPDATE message_deliveries SET state='resolved' WHERE dispatch_id=?").run(done.id)
  preview = await read()
  expect(preview.eligible).toBe(1)
  const request = {
    operation_id: randomUUID(),
    expected_version: preview.version,
    dispatch_ids: [done.id],
    action: 'archive',
    confirm: true,
  }
  expect((await f.call(url, { ...request, dispatch_ids: [pending.id] })).status).toBe(409)
  const receipt = await (await f.call(url, request)).json()
  expect(receipt).toMatchObject({
    files_deleted: 0,
    physical_bytes_reclaimed: 0,
    dispatch_ids: [done.id],
  })
  expect(await (await f.call(url, request)).json()).toEqual(receipt)
  expect(f.store.getDispatch(f.workspace.id, done.id)?.reportText).toBe('done')
  expect(f.store.deliveryHistory.page(f.workspace.id).items.map((item) => item.id)).not.toContain(
    done.id
  )
  const next = await read()
  expect(
    next.records.find((r: { dispatch_id: string }) => r.dispatch_id === done.id).archived
  ).toBe(true)
  expect(
    (
      await f.call(url, {
        operation_id: randomUUID(),
        expected_version: next.version,
        dispatch_ids: [done.id],
        action: 'restore',
        confirm: true,
      })
    ).status
  ).toBe(200)
  expect(f.store.deliveryHistory.page(f.workspace.id).summary.total).toBe(2)
})
