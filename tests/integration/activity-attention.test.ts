import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import { createAttentionFixture } from '../helpers/attention-fixture.js'

const fixtures: Awaited<ReturnType<typeof createAttentionFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})
const fixture = async () => {
  const f = await createAttentionFixture()
  fixtures.push(f)
  return f
}

test('only unanswered protocol questions on open dispatches need attention', async () => {
  const f = await fixture(),
    store = f.server.store
  const dispatch = await f.task('Decide API behavior', 1)
  const ask = () =>
    store.dispatchMessages.send(f.workspace.id, dispatch.id, f.worker.id, {
      kind: 'question',
      body: 'Which API version?',
    })
  const question = ask()
  store.dispatchMessages.send(f.workspace.id, dispatch.id, f.actor, {
    kind: 'note',
    body: 'Investigating?',
    replyTo: question.id,
  })
  expect((await f.page('filter=question')).items).toEqual([
    expect.objectContaining({
      id: `question:${question.id}`,
      agent_id: f.actor,
      message_id: question.id,
      detail: 'Which API version?',
      root_dispatch_id: dispatch.id,
    }),
  ])
  store.dispatchMessages.send(f.workspace.id, dispatch.id, f.actor, {
    kind: 'answer',
    body: 'Use v2',
    replyTo: question.id,
  })
  expect((await f.page('filter=question')).items).toEqual([])
  const next = ask()
  expect((await f.page('filter=question')).items[0]?.id).toBe(`question:${next.id}`)
  store.reportTask(f.workspace.id, f.worker.id, {
    dispatchId: dispatch.id,
    seenSeq: 4,
    text: 'Applied v2',
    outcome: 'success',
    requireActiveRun: true,
  })
  expect((await f.page('filter=question')).items).toEqual([])
  expect((await f.page('filter=acceptance')).filtered_total).toBe(1)
})

test('report delivery, acceptance and refresh preserve independent durable facts', async () => {
  const f = await fixture()
  const { dispatch, receipt } = await f.report('Build the API')
  const first = await f.page()
  expect(first.counts).toEqual({
    question: 0,
    report_delivery: 1,
    stopped_worker: 0,
    acceptance: 1,
    remote_connection: 0,
  })
  const records = f.server.store.dispatchDelivery.records
  records.confirm(dispatch.id, 'worker_ack')
  expect(records.claim(receipt.id, 'previous-controller')?.attempt).toBe(1)
  records.failed(receipt.id, 1, 'Composer requires review', 'manual')
  const facts = () => ({
    outbox: f.db.prepare('SELECT * FROM report_outbox').all(),
    receipts: records.list(f.workspace.id),
    dispatch: f.server.store.getDispatch(f.workspace.id, dispatch.id),
  })
  const before = facts()
  for (let i = 0; i < 3; i++) {
    const page = await f.page()
    expect(page.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id))
    expect(page.items.find((item) => item.kind === 'report_delivery')).toMatchObject({
      id: `report:${receipt.id}`,
      delivery_id: receipt.id,
      state: 'manual',
      detail: 'Composer requires review',
    })
  }
  expect(facts()).toEqual(before)
  const accepted = await f.request(
    `/api/ui/workspaces/${f.workspace.id}/dispatches/${dispatch.id}/accept`,
    { report_revision: 1 }
  )
  expect(accepted.status, await accepted.clone().text()).toBe(200)
  expect((await f.page()).counts).toMatchObject({ acceptance: 0, report_delivery: 1 })
  const resolved = await f.request(
    `/api/ui/workspaces/${f.workspace.id}/message-deliveries/${receipt.id}/resolve`,
    { action: 'handled', reason: 'Controller reviewed the report', composer_safe: true }
  )
  expect(resolved.status, await resolved.clone().text()).toBe(200)
  expect((await f.page()).items).toEqual([])
  expect(
    f.db.prepare('SELECT delivered_at FROM report_outbox WHERE receipt_id=?').get(receipt.id)
  ).toMatchObject({ delivered_at: expect.any(Number) })
})

test('blocked reports are not offered acceptance and report details remain workspace scoped', async () => {
  const f = await fixture(),
    { dispatch } = await f.report('Blocked API', 'blocked')
  expect((await f.page()).counts).toMatchObject({ acceptance: 0, report_delivery: 1 })
  const path = `/api/ui/workspaces/${f.workspace.id}/dispatches/${dispatch.id}`
  expect((await fetch(f.server.baseUrl + path)).status).toBe(403)
  expect(await (await f.request(path)).json()).toMatchObject({
    id: dispatch.id,
    workspace_id: f.workspace.id,
    report_outcome: 'blocked',
    report_text: 'Completed: Blocked API',
    report_revision: 1,
  })
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'other'), 'Other')
  expect((await f.request(`/api/ui/workspaces/${other.id}/dispatches/${dispatch.id}`)).status).toBe(
    404
  )
  expect((await f.get('', other.id)).status).toBe(200)
  expect((await (await f.get('', other.id)).json()).items).toEqual([])
})

test('a stopped member leaves attention after a real PTY starts without a read starting it', async () => {
  const f = await fixture()
  const task = await f.task('Queued while stopped')
  expect((await f.page()).items).toEqual([
    expect.objectContaining({ id: `stopped:${task.id}`, agent_id: f.worker.id }),
  ])
  expect(
    f.server.store
      .getWorkspaceSnapshot(f.workspace.id)
      .agents.find((agent) => agent.id === f.worker.id)?.status
  ).toBe('stopped')
  const script = join(f.workspace.path, 'idle.cjs')
  writeFileSync(script, "console.log('ATTENTION_READY');process.stdin.resume()")
  f.server.store.configureAgentLaunch(f.workspace.id, f.worker.id, {
    command: process.execPath,
    args: [script],
  })
  const response = await f.request(
    `/api/workspaces/${f.workspace.id}/agents/${f.worker.id}/start`,
    {}
  )
  expect(response.status, await response.clone().text()).toBe(201)
  const run = (await response.json()) as { run_id: string }
  await expect
    .poll(() => f.server.store.getLiveRun(run.run_id).output, { timeout: 15000 })
    .toContain('ATTENTION_READY')
  expect((await f.page('filter=stopped_worker')).items).toEqual([])
  // Queued work remains a fact while only the visible member status changes.
  f.server.store.stopAgentRun(run.run_id)
  await expect
    .poll(async () => (await f.page('filter=stopped_worker')).items.length, { timeout: 10000 })
    .toBe(1)
}, 30000)

test('keyset pages retain global counts, omit archived work and bind cursors to their scope', async () => {
  const f = await fixture(),
    ids: string[] = []
  const insert = f.db.prepare(
    'INSERT INTO dispatches(id,workspace_id,to_agent_id,text,status,created_at) VALUES(?,?,?,?,?,?)'
  )
  f.db.transaction(() => {
    for (let i = 0; i < 57; i++) {
      const id = randomUUID()
      ids.push(`stopped:${id}`)
      insert.run(id, f.workspace.id, f.worker.id, `Queued ${i}`, 'queued', 1000)
    }
  })()
  let page = await f.page('limit=11')
  expect(page).toMatchObject({ total: 57, filtered_total: 57, counts: { stopped_worker: 57 } })
  const cursor = page.next_cursor
  expect(cursor).toEqual(expect.any(String))
  const collected = page.items.map((item) => item.id)
  // A new item after this traversal's cutoff belongs to the next refresh.
  const next = randomUUID()
  insert.run(next, f.workspace.id, f.worker.id, 'Newly queued', 'queued', page.generated_at + 1)
  while (page.next_cursor) {
    page = await f.page(`limit=11&cursor=${page.next_cursor}`)
    collected.push(...page.items.map((item) => item.id))
  }
  expect(collected).toEqual(ids.sort())
  expect(new Set(collected).size).toBe(57)
  expect((await f.page()).total).toBe(58)
  const archiveId = randomUUID()
  f.db
    .prepare(
      'INSERT INTO data_archive_operations(id,workspace_id,preview_version,receipt_json,completed_at) VALUES(?,?,?,?,?)'
    )
    .run(archiveId, f.workspace.id, 'fixture', '{}', Date.now())
  f.db
    .prepare('INSERT INTO dispatch_archives(dispatch_id,operation_id,archived_at) VALUES(?,?,?)')
    .run(next, archiveId, Date.now())
  expect((await f.page()).total).toBe(57)

  expect((await f.get(`filter=question&cursor=${cursor}`)).status).toBe(400)
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'other'), 'Other')
  expect((await f.get(`cursor=${cursor}`, other.id)).status).toBe(400)
  for (const query of [
    'limit=0',
    'limit=101',
    'limit=1.5',
    'limit=NaN',
    'filter=missing',
    'cursor=broken',
  ])
    expect((await f.get(query)).status).toBe(400)
  expect(
    (await fetch(`${f.server.baseUrl}/api/ui/workspaces/${f.workspace.id}/attention`)).status
  ).toBe(403)
  expect((await f.get('', randomUUID())).status).toBe(404)
})

test('local remote-connection reminders respect enabled state and remote workspace read scopes', async () => {
  const f = await fixture(),
    { dispatch } = await f.report('Scoped report')
  f.server.store.settings.internalAppState.set('remote_enabled', 'true')
  const local = await f.page()
  expect(local.items.find((item) => item.kind === 'remote_connection')).toMatchObject({
    id: 'remote:connection',
    since: null,
    state: 'loggedOut',
  })
  const device = f.server.store.remote.devices.insert({
    id: randomUUID(),
    name: 'Attention reader',
    keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
    devicePublicKey: new Uint8Array(32).fill(3),
  })
  const headers = stampLoopbackHeaders({}, f.server.store.getRemoteTunnelSecret(), device.id)
  const path = `/api/ui/workspaces/${f.workspace.id}/attention`
  expect((await fetch(f.server.baseUrl + path, { headers })).status).toBe(403)
  const scope = await fetch(`${f.server.baseUrl}/api/remote/devices/${device.id}/scopes`, {
    method: 'PUT',
    headers: { cookie: f.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ workspace_ids: [f.workspace.id] }),
  })
  expect(scope.status).toBe(200)
  const response = await fetch(f.server.baseUrl + path, { headers })
  expect(response.status).toBe(200)
  const remote = await response.json()
  expect(remote.counts).toMatchObject({ remote_connection: 0, acceptance: 1, report_delivery: 1 })
  expect(
    remote.items.every((item: { workspace_id: string }) => item.workspace_id === f.workspace.id)
  ).toBe(true)
  const detail = await fetch(
    `${f.server.baseUrl}/api/ui/workspaces/${f.workspace.id}/dispatches/${dispatch.id}`,
    { headers }
  )
  expect(detail.status).toBe(200)
  expect(await detail.json()).toMatchObject({
    id: dispatch.id,
    report_text: 'Completed: Scoped report',
  })
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'private'), 'Private')
  expect(
    (await fetch(`${f.server.baseUrl}/api/ui/workspaces/${other.id}/attention`, { headers })).status
  ).toBe(403)
  f.server.store.settings.internalAppState.set('remote_enabled', 'false')
  expect((await f.page()).counts.remote_connection).toBe(0)
})
