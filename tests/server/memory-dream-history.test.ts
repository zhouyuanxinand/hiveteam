import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createMessageLogStore } from '../../src/server/message-log-store.js'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import type { TeamMemoryDreamRun } from '../../src/shared/team-memory.js'
import { createAttentionFixture } from '../helpers/attention-fixture.js'

type Fixture = Awaited<ReturnType<typeof createAttentionFixture>>
interface DreamPayload {
  id: string
  created_at: number
  workspace_id: string
  status: TeamMemoryDreamRun['status']
  plan_version: number
  plan_revision: number
  change_receipt: TeamMemoryDreamRun['receipt']
}
interface HistoryPage {
  runs: DreamPayload[]
  next_cursor: string | null
  review_count: number
}

const fixtures: Fixture[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})
const fixture = async () => {
  const f = await createAttentionFixture()
  fixtures.push(f)
  const path = `/api/ui/workspaces/${f.workspace.id}/memory/dream`
  const page = async (query = ''): Promise<HistoryPage> => {
    const response = await f.request(`${path}/history${query ? `?${query}` : ''}`)
    expect(response.status).toBe(200)
    return response.json()
  }
  const create = (createdAt: number) => {
    const run = f.server.store.memoryDream.create(f.workspace.id)
    f.db.prepare('UPDATE memory_dream_runs SET created_at=? WHERE id=?').run(createdAt, run.id)
    return run
  }
  const discard = (run: Pick<TeamMemoryDreamRun, 'id' | 'planRevision'>) =>
    f.request(`${path}/${run.id}/discard`, { expected_revision: run.planRevision })
  return { ...f, path, page, create, discard }
}

test('history pages tied timestamps without duplicates or omissions and preserves the legacy list', async () => {
  const f = await fixture()
  const createdAt = Date.now() - 1000
  const ids = Array.from({ length: 57 }, () => f.create(createdAt).id)
    .sort()
    .reverse()
  const legacy = await f.request(f.path)
  expect(legacy.status).toBe(200)
  const legacyRuns: DreamPayload[] = await legacy.json()
  expect(Array.isArray(legacyRuns)).toBe(true)
  expect(legacyRuns).toHaveLength(20)

  const first = await f.page()
  expect(first.runs.map((run) => run.id)).toEqual(ids.slice(0, 20))
  expect(first.review_count).toBe(57)
  expect(first.next_cursor).toBe(ids[19])
  const second = await f.page(`cursor=${first.next_cursor}`)
  expect(second.runs.map((run) => run.id)).toEqual(ids.slice(20, 40))
  expect(second.review_count).toBe(57)
  expect(second.next_cursor).toBe(ids[39])
  const third = await f.page(`cursor=${second.next_cursor}`)
  expect(third.runs.map((run) => run.id)).toEqual(ids.slice(40))
  expect(third.review_count).toBe(57)
  expect(third.next_cursor).toBeNull()
  expect([...first.runs, ...second.runs, ...third.runs].map((run) => run.id)).toEqual(ids)

  const maximum = await f.page('limit=50&review_only=false')
  expect(maximum.runs.map((run) => run.id)).toEqual(ids.slice(0, 50))
  expect(maximum.next_cursor).toBe(ids[49])
})

test('review pagination survives a completed cursor, a completed later draft and a newer insertion', async () => {
  const f = await fixture()
  const createdAt = Date.now() - 1000
  const drafts = Array.from({ length: 23 }, () => f.create(createdAt))
  const ids = drafts
    .map((run) => run.id)
    .sort()
    .reverse()
  const legacy = f.create(createdAt)
  f.db.prepare('UPDATE memory_dream_runs SET plan_version=0 WHERE id=?').run(legacy.id)
  const closed = f.create(createdAt)
  expect((await f.discard(closed)).status).toBe(200)

  const first = await f.page('limit=10&review_only=true')
  expect(first.runs.map((run) => run.id)).toEqual(ids.slice(0, 10))
  expect(first.review_count).toBe(23)
  const cursor = first.runs.at(-1)
  const later = drafts.find((run) => run.id === ids[12])
  if (!cursor || !later) throw new Error('Missing pagination fixture')
  expect((await f.discard({ id: cursor.id, planRevision: cursor.plan_revision })).status).toBe(200)
  expect((await f.discard(later)).status).toBe(200)
  const inserted = f.create(createdAt + 1000)

  const next = await f.page(`limit=20&review_only=true&cursor=${cursor.id}`)
  expect(next.runs.map((run) => run.id)).toEqual(ids.slice(10).filter((id) => id !== later.id))
  expect(next.runs.every((run) => run.plan_version === 1 && run.status === 'review')).toBe(true)
  expect(next.next_cursor).toBeNull()
  expect(next.review_count).toBe(22)
  const refreshed = await f.page('review_only=true')
  expect(refreshed.runs[0]?.id).toBe(inserted.id)
  expect((await f.page()).review_count).toBe(22)
})

test('an older review draft remains reachable and discarding it unblocks generation', async () => {
  const f = await fixture()
  const old = f.create(Date.now() - 10000)
  for (let index = 0; index < 25; index += 1) {
    const run = f.create(Date.now() - 1000 + index)
    f.server.store.memoryDream.discard(f.workspace.id, run.id, run.planRevision)
  }
  createMessageLogStore(f.db).insertMessage({
    workspaceId: f.workspace.id,
    workerId: f.actor,
    type: 'user_input',
    text: 'Publish only signed release artifacts.',
    createdAt: Date.now(),
  })
  const legacy: DreamPayload[] = await (await f.request(f.path)).json()
  expect(legacy).toHaveLength(20)
  expect(legacy.map((run) => run.id)).not.toContain(old.id)
  expect((await f.request(`${f.path}/generate`, {})).status).toBe(409)
  const reviews = await f.page('review_only=true')
  expect(reviews).toMatchObject({
    runs: [{ id: old.id, status: 'review', plan_revision: old.planRevision }],
    next_cursor: null,
    review_count: 1,
  })
  expect(reviews.runs).toHaveLength(1)
  const detail = await f.request(`${f.path}/${old.id}`)
  expect(detail.status).toBe(200)
  expect(await detail.json()).toEqual(reviews.runs[0])
  expect((await f.discard(old)).status).toBe(200)
  expect(await f.page('review_only=true')).toEqual({
    runs: [],
    next_cursor: null,
    review_count: 0,
  })
  const generated = await f.request(`${f.path}/generate`, {})
  expect(generated.status).toBe(201)
  const run = await generated.json()
  expect(run.id).not.toBe(old.id)
  expect(run.generation).toMatchObject({ status: 'pending' })
  expect(f.server.store.memoryDream.get(f.workspace.id, old.id)?.status).toBe('discarded')
})

test('older applied history preserves its exact receipt and detail reads stay workspace scoped', async () => {
  const f = await fixture()
  const source = f.server.store.memory.create(f.workspace.id, { kind: 'fact', body: 'Old fact' })
  const old = f.create(Date.now() - 10000)
  const operation = old.operations[0]
  if (!operation?.result) throw new Error('Expected a rewrite proposal')
  const submitted = await f.request(`${f.path}/${old.id}/submit`, {
    orchestrator_id: f.actor,
    expected_revision: old.planRevision,
    operations: [{ ...operation, result: { ...operation.result, body: 'Reviewed fact' } }],
  })
  expect(submitted.status).toBe(200)
  const applied = await submitted.json()
  expect(applied.change_receipt.changes).toEqual([
    expect.objectContaining({
      memory_id: source.id,
      before: expect.objectContaining({ body: 'Old fact' }),
      after: expect.objectContaining({ body: 'Reviewed fact' }),
    }),
  ])
  for (let index = 0; index < 25; index += 1) {
    const run = f.create(Date.now() - 1000 + index)
    f.server.store.memoryDream.discard(f.workspace.id, run.id, run.planRevision)
  }
  const first = await f.page()
  expect(first.runs.map((run) => run.id)).not.toContain(old.id)
  const next = await f.page(`cursor=${first.next_cursor}`)
  expect(next.runs.find((run) => run.id === old.id)).toEqual(applied)
  expect(next.review_count).toBe(0)
  const detail = await f.request(`${f.path}/${old.id}`)
  expect(detail.status).toBe(200)
  expect(await detail.json()).toEqual(applied)
  expect(f.server.store.memory.get(f.workspace.id, source.id)?.body).toBe('Reviewed fact')

  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'other'), 'Other')
  const foreign = f.server.store.memoryDream.create(other.id)
  expect((await f.request(`${f.path}/${foreign.id}`)).status).toBe(404)
  expect((await f.request(`/api/ui/workspaces/${other.id}/memory/dream/${old.id}`)).status).toBe(
    404
  )
  expect((await f.request(`${f.path}/${randomUUID()}`)).status).toBe(404)
  expect((await f.page()).runs.map((run) => run.id)).not.toContain(foreign.id)
})

test('history rejects malformed filters and unknown or foreign cursors', async () => {
  const f = await fixture()
  f.create(Date.now())
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'other'), 'Other')
  const foreign = f.server.store.memoryDream.create(other.id)
  const queries = [
    ...['0', '-1', '1.5', 'no', '51', ''].map((limit) => `limit=${limit}`),
    ...['1', 'yes', 'TRUE', ''].map((reviewOnly) => `review_only=${reviewOnly}`),
    `cursor=${randomUUID()}`,
    `cursor=${foreign.id}`,
    `review_only=true&cursor=${foreign.id}`,
  ]
  for (const query of queries) {
    const response = await f.request(`${f.path}/history?${query}`)
    expect(response.status, query).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.any(String) })
  }
  expect((await f.page()).runs).toHaveLength(1)
})

test('history and detail require UI authentication and scoped remote read access', async () => {
  const f = await fixture()
  const run = f.create(Date.now())
  const paths = [`${f.path}/history`, `${f.path}/${run.id}`]
  for (const path of paths) {
    const response = await fetch(f.server.baseUrl + path)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'UI endpoint requires valid UI token' })
  }
  const device = f.server.store.remote.devices.insert({
    id: randomUUID(),
    name: 'History reader',
    keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
    devicePublicKey: new Uint8Array(32).fill(3),
  })
  const headers = stampLoopbackHeaders(
    { 'content-type': 'application/json' },
    f.server.store.getRemoteTunnelSecret(),
    device.id
  )
  const remote = (path: string) => fetch(f.server.baseUrl + path, { headers })
  for (const path of paths) {
    const response = await remote(path)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'remote_workspace_forbidden' })
  }
  f.server.store.remote.permissions.setReadScopes(device.id, [f.workspace.id])
  const history = await remote(paths[0] ?? '')
  expect(history.status).toBe(200)
  expect(await history.json()).toMatchObject({ runs: [{ id: run.id }], review_count: 1 })
  const detail = await remote(paths[1] ?? '')
  expect(detail.status).toBe(200)
  expect(await detail.json()).toMatchObject({ id: run.id, workspace_id: f.workspace.id })
  const agentRead = await fetch(`${f.server.baseUrl}/api/team/dream/input`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project_id: f.workspace.id,
      from_agent_id: f.actor,
      token: f.server.store.peekAgentToken(f.actor),
      dream_id: run.id,
      section: 'operations',
    }),
  })
  expect(agentRead.status).toBe(403)
  expect(await agentRead.json()).toMatchObject({ code: 'remote_endpoint_forbidden' })
  f.server.store.remote.permissions.setReadScopes(device.id, [])
  for (const path of paths) expect((await remote(path)).status).toBe(403)
})
