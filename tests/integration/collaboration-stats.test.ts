import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { createMessageDeliveryStore } from '../../src/server/message-delivery-store.js'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import { applySchemaVersion63 } from '../../src/server/sqlite-schema-v63.js'
import type { CollaborationStatistics } from '../../src/shared/collaboration-stats.js'
import { createAttentionFixture } from '../helpers/attention-fixture.js'
import { seedCollaborationStats } from '../helpers/collaboration-stats-fixture.js'

const fixtures: Awaited<ReturnType<typeof createAttentionFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})
const fixture = async () => {
  const f = await createAttentionFixture()
  fixtures.push(f)
  const path = `/api/ui/workspaces/${f.workspace.id}/collaboration-stats`
  const stats = async (period = 'all'): Promise<CollaborationStatistics> => {
    const response = await f.request(`${path}?period=${period}`)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return response.json()
  }
  return { ...f, path, stats }
}

test('HTTP aggregates root families, fixed event durations, percentiles and historical measurement gaps without writes', async () => {
  const f = await fixture()
  seedCollaborationStats(f)
  const facts = () => ({
    dispatches: f.db.prepare('SELECT * FROM dispatches').all(),
    events: f.db.prepare('SELECT * FROM message_delivery_events').all(),
    measurements: f.db.prepare('SELECT * FROM delivery_payload_measurements').all(),
  })
  const before = facts()
  const value = await f.stats()
  expect(value.counts).toEqual({
    root_tasks: 3,
    dispatches: 4,
    messages: 3,
    reworks: 1,
    delivery_attempts: 8,
    retries: 1,
  })
  expect(value.durations).toEqual({
    queue: { sample_count: 2, missing_count: 1, mean_ms: 225, p50_ms: 150, p95_ms: 300 },
    execution: { sample_count: 2, missing_count: 1, mean_ms: 750, p50_ms: 600, p95_ms: 900 },
    report_submission: {
      sample_count: 2,
      missing_count: 1,
      mean_ms: 155,
      p50_ms: 110,
      p95_ms: 200,
    },
    acceptance_to_integration: {
      sample_count: 2,
      missing_count: 1,
      mean_ms: 350,
      p50_ms: 200,
      p95_ms: 500,
    },
  })
  expect(value.payload).toEqual({
    total_bytes: 9,
    measured_attempts: 2,
    unmeasured_attempts: 6,
    pending_deliveries: 1,
  })
  const states = f.server.store.dispatchDelivery.records.list(f.workspace.id)
  expect((await f.stats()).counts).toEqual(value.counts)
  expect((await f.stats()).payload).toEqual(value.payload)
  expect(f.server.store.dispatchDelivery.records.list(f.workspace.id)).toEqual(states)
  expect(facts()).toEqual(before)
})

test('period selection follows root creation, keeps retained archives and scopes reads to a workspace', async () => {
  const f = await fixture(),
    ids = seedCollaborationStats(f),
    now = Date.now()
  for (const [id, days] of [
    [ids.root, 40],
    [ids.second, 10],
    [ids.queued, 1],
  ] as const)
    f.db.prepare('UPDATE dispatches SET created_at=? WHERE id=?').run(now - days * 86_400_000, id)
  // A child created today stays with its older root, even after that root is archived.
  const operation = randomUUID()
  f.db
    .prepare('INSERT INTO data_archive_operations VALUES(?,?,?,?,?)')
    .run(operation, f.workspace.id, 'fixture', '{}', now)
  f.db.prepare('INSERT INTO dispatch_archives VALUES(?,?,?)').run(ids.root, operation, now)
  expect((await f.stats('7')).counts).toMatchObject({ root_tasks: 1, dispatches: 1, messages: 0 })
  expect((await f.stats('30')).counts).toMatchObject({ root_tasks: 2, dispatches: 2, messages: 0 })
  expect((await f.stats('all')).counts).toMatchObject({ root_tasks: 3, dispatches: 4, messages: 3 })
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'private'), 'Private')
  const empty = await (await f.request(`/api/ui/workspaces/${other.id}/collaboration-stats`)).json()
  expect(empty.counts.root_tasks).toBe(0)
  expect(empty.payload.total_bytes).toBeNull()
  expect(empty.durations.execution).toEqual({
    sample_count: 0,
    missing_count: 0,
    mean_ms: null,
    p50_ms: null,
    p95_ms: null,
  })
  expect((await fetch(f.server.baseUrl + f.path)).status).toBe(403)
  expect((await f.request(`/api/ui/workspaces/${randomUUID()}/collaboration-stats`)).status).toBe(
    404
  )
  for (const period of ['', '0', '8', '-1', 'all%27'])
    expect((await f.request(`${f.path}?period=${period}`)).status).toBe(400)
  const device = f.server.store.remote.devices.insert({
    id: randomUUID(),
    name: 'Statistics reader',
    keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
    devicePublicKey: new Uint8Array(32).fill(3),
  })
  const headers = stampLoopbackHeaders({}, f.server.store.getRemoteTunnelSecret(), device.id)
  expect((await fetch(f.server.baseUrl + f.path, { headers })).status).toBe(403)
  const grant = await fetch(`${f.server.baseUrl}/api/remote/devices/${device.id}/scopes`, {
    method: 'PUT',
    headers: { cookie: f.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ workspace_ids: [f.workspace.id] }),
  })
  expect(grant.status).toBe(200)
  expect((await fetch(f.server.baseUrl + f.path, { headers })).status).toBe(200)
  expect(
    (
      await fetch(`${f.server.baseUrl}/api/ui/workspaces/${other.id}/collaboration-stats`, {
        headers,
      })
    ).status
  ).toBe(403)
})

test('missing, cancelled and reversed endpoints are excluded; zero-duration events remain samples', async () => {
  const f = await fixture(),
    ids = seedCollaborationStats(f)
  f.db.prepare('UPDATE dispatches SET submitted_at=created_at-1 WHERE id=?').run(ids.root)
  f.db.prepare('UPDATE dispatches SET reported_at=submitted_at WHERE id=?').run(ids.second)
  f.db.prepare("UPDATE dispatches SET status='cancelled' WHERE id=?").run(ids.review)
  f.db
    .prepare(
      "UPDATE message_deliveries SET submitted_at=NULL WHERE dispatch_id=? AND kind='report'"
    )
    .run(ids.second)
  const value = await f.stats()
  expect(value.durations.queue).toMatchObject({ sample_count: 1, missing_count: 2, mean_ms: 300 })
  expect(value.durations.execution).toMatchObject({
    sample_count: 1,
    missing_count: 2,
    mean_ms: 0,
    p50_ms: 0,
    p95_ms: 0,
  })
  expect(value.durations.report_submission).toMatchObject({
    sample_count: 1,
    missing_count: 2,
    mean_ms: 110,
  })
})

test('payload measurement persists once per attempt, retries do not create tasks, and rework follows reopening', async () => {
  const f = await fixture(),
    task = await f.task('Unicode 中文🙂')
  let clock = Date.now()
  const deliveries = createMessageDeliveryStore(f.db, () => clock)
  const ledger = createDispatchLedgerStore(f.db)
  expect((await f.stats()).payload.total_bytes).toBeNull()
  expect(deliveries.claim(task.id, 'run-one')?.attempt).toBe(1)
  deliveries.prepared(task.id, 1, '中文🙂')
  deliveries.prepared(task.id, 1, '中文🙂')
  expect((await f.stats()).payload).toMatchObject({
    total_bytes: 10,
    measured_attempts: 1,
    unmeasured_attempts: 0,
  })
  deliveries.failed(task.id, 1, 'Before write')
  clock += 2000
  expect(deliveries.claim(task.id, 'run-two')?.attempt).toBe(2)
  deliveries.prepared(task.id, 2, '再试')
  deliveries.submitted(task.id, 2, false)
  ledger.markSubmitted(task.id)
  const value = await f.stats()
  expect(value.counts).toMatchObject({
    root_tasks: 1,
    dispatches: 1,
    delivery_attempts: 2,
    retries: 1,
  })
  expect(value.payload).toMatchObject({ total_bytes: 16, measured_attempts: 2 })
  ledger.markReportedByWorker({
    workspaceId: f.workspace.id,
    toAgentId: f.worker.id,
    dispatchId: task.id,
    reportText: 'First',
    artifacts: [],
  })
  expect((await f.stats()).counts.reworks).toBe(0)
  expect(ledger.reopenReportedDispatch(f.workspace.id, task.id)).toBe(true)
  expect((await f.stats()).counts.reworks).toBe(1)
  ledger.markReportedByWorker({
    workspaceId: f.workspace.id,
    toAgentId: f.worker.id,
    dispatchId: task.id,
    reportText: 'Second',
    artifacts: [],
  })
  expect((await f.stats()).counts.reworks).toBe(1)
  const before = f.db.prepare('SELECT * FROM delivery_payload_measurements').all()
  applySchemaVersion63(f.db)
  applySchemaVersion63(f.db)
  expect(f.db.prepare('SELECT * FROM delivery_payload_measurements').all()).toEqual(before)
  expect(() => deliveries.prepared(task.id, 1, 'stale')).toThrow('stopped or superseded')
  expect(f.db.prepare('SELECT * FROM delivery_payload_measurements').all()).toEqual(before)
  f.db.prepare('DELETE FROM dispatches WHERE id=?').run(task.id)
  expect(f.db.prepare('SELECT * FROM delivery_payload_measurements').all()).toEqual([])
  expect(f.db.pragma('foreign_key_check')).toEqual([])
})
