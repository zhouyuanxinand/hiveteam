import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, test } from 'vitest'
import { createCodeReviewFixture } from '../helpers/code-review-fixture.js'

const fixtures: Awaited<ReturnType<typeof createCodeReviewFixture>>[] = []
afterEach(async () => {
  delete process.env.HIVETEAM_SYNTHETIC_DEPENDENCY
  for (const f of fixtures.splice(0)) await f.close()
})
const until = async (check: () => Promise<void>) => {
  const deadline = Date.now() + 30000
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 75))
    }
  }
}
const setup = async () => {
  const f = await createCodeReviewFixture()
  fixtures.push(f)
  const root = `/api/ui/workspaces/${f.workspace.id}`
  const request = (path: string, body?: unknown, method = 'POST') =>
    fetch(`${f.server.baseUrl}${root}${path}`, {
      method: body === undefined ? 'GET' : method,
      headers: { cookie: f.cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const profile = async (command: string, fields: Record<string, unknown> = {}) => {
    const response = await request('/verification-profiles', {
      name: 'Checks',
      command,
      execution: 'trusted_unsafe',
      network: 'unrestricted',
      timeout_ms: 15000,
      ...fields,
    })
    expect(response.status, await response.clone().text()).toBe(201)
    return response.json() as Promise<{ id: string }>
  }
  const start = async (id: string) => {
    const response = await request(`/dispatches/${f.dispatch.id}/verifications`, {
      profile_id: id,
      head_sha: f.source,
      report_revision: 1,
    })
    expect(response.status, await response.clone().text()).toBe(202)
    return response.json() as Promise<{ id: string }>
  }
  return { f, request, profile, start }
}

test('persisted legacy queued commands retain their concurrency limit after profile migration', async () => {
  const { f, request } = await setup()
  const worker = f.server.store.addWorker(f.workspace.id, { name: 'Legacy peer', role: 'coder' })
  await f.server.store.worktrees.create(f.workspace, worker.id)
  const dispatch = await f.server.store.dispatchTask(
    f.workspace.id,
    worker.id,
    'Another legacy result'
  )
  f.server.store.reportTask(f.workspace.id, worker.id, {
    dispatchId: dispatch.id,
    outcome: 'success',
    text: 'Ready',
  })
  const lease = f.server.store.resources.reserve({
    workspaceId: f.workspace.id,
    kind: 'verification',
    executionKey: `migration-fixture:${randomUUID()}`,
  })
  const first = await request(`/dispatches/${f.dispatch.id}/verifications`, {
    command: 'node -e "console.log(\'LEGACY_RUNNING\');setInterval(()=>{},1000)"',
    head_sha: f.source,
    report_revision: 1,
  })
  expect(first.status).toBe(202)
  const legacy = await first.json()
  expect(legacy.state).toBe('queued')
  const db = new Database(join(f.dataDir, 'runtime.sqlite'))
  try {
    db.prepare('UPDATE dispatch_verifications SET profile_json=NULL WHERE id=?').run(legacy.id)
  } finally {
    db.close()
  }
  f.server.store.resources.release(lease.id, { reason: 'spawn_not_started' })
  await until(async () =>
    expect(f.server.store.verifications.get(legacy.id)).toMatchObject({
      state: 'running',
      output: expect.stringContaining('LEGACY_RUNNING'),
    })
  )
  expect(f.server.store.verifications.get(legacy.id)?.profile).toBeUndefined()
  f.server.store.resources.updateLimits(
    { max_verification_per_workspace: 2 },
    { actor: 'local_user' }
  )
  const nextResponse = await request(`/dispatches/${dispatch.id}/verifications`, {
    command: 'node -e "console.log(\'LEGACY_FINISHED\')"',
    head_sha: f.baseline,
    report_revision: 1,
  })
  expect(nextResponse.status).toBe(202)
  const next = await nextResponse.json()
  expect(next.state).toBe('queued')
  expect(f.server.store.resourceQueue.list(f.workspace.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        execution_key: `verification:${next.id}`,
        reason: 'verification_profile_concurrency_limit',
      }),
    ])
  )
  expect(f.server.store.resources.getSnapshot().occupancy.by_kind.verification).toBe(1)
  expect(
    (await request(`/dispatches/${f.dispatch.id}/verifications/${legacy.id}/cancel`, {})).status
  ).toBe(200)
  await until(async () =>
    expect(f.server.store.verifications.get(next.id)).toMatchObject({
      state: 'passed',
      output: expect.stringContaining('LEGACY_FINISHED'),
    })
  )
}, 90000)
test('profiles persist immutable preparation and timeout snapshots; full logs retain the tail and paginate after restart', async () => {
  const { f, request, profile, start } = await setup()
  const saved = await profile(
    "node -e \"process.stdout.write('x'.repeat(150000));console.log('TAIL_FAILURE token=synthetic-secret');process.exitCode=1\"",
    {
      prepare_commands: ['node -e "console.log(\'PREPARED\')"'],
    }
  )
  const run = await start(saved.id)
  await until(async () => expect(f.server.store.verifications.get(run.id)?.state).toBe('failed'))
  expect(f.server.store.verifications.get(run.id)?.output).toContain('TAIL_FAILURE')
  expect(f.server.store.verifications.get(run.id)?.output.length).toBeLessThanOrEqual(65536)
  const tail = await request(`/dispatches/${f.dispatch.id}/verifications/${run.id}/log`)
  expect(tail.status).toBe(200)
  const page = await tail.json()
  expect(page.text).toContain('TAIL_FAILURE token=[REDACTED]')
  expect(page.total_bytes).toBeGreaterThan(150000)
  const first = await request(
    `/dispatches/${f.dispatch.id}/verifications/${run.id}/log?offset=0&limit=1024`
  )
  expect(await first.json()).toMatchObject({
    offset: 0,
    next_offset: 1024,
    truncated: true,
    text: expect.stringContaining('PREPARED'),
  })
  await f.restart()
  expect((await (await request('/verification-profiles')).json())[0].id).toBe(saved.id)
  expect(
    await (await request(`/dispatches/${f.dispatch.id}/verifications/${run.id}/log`)).json()
  ).toMatchObject({ text: expect.stringContaining('TAIL_FAILURE') })
  const edited = await request(
    `/verification-profiles/${saved.id}`,
    {
      name: 'Changed',
      command: 'node -e "console.log(123)"',
      execution: 'trusted_unsafe',
      network: 'unrestricted',
      timeout_ms: 1000,
    },
    'PUT'
  )
  expect(edited.status).toBe(200)
  expect(f.server.store.verifications.get(run.id)?.profile?.timeout_ms).toBe(15000)
}, 90000)

test('independent verifications obey the profile cap and cancelling one leaves the other process running', async () => {
  const { f, profile, start, request } = await setup()
  f.server.store.resources.updateLimits(
    { max_verification_per_workspace: 2 },
    { actor: 'local_user' }
  )
  const worker = f.server.store.addWorker(f.workspace.id, { name: 'Parallel check', role: 'coder' })
  await f.server.store.worktrees.create(f.workspace, worker.id)
  const dispatch = await f.server.store.dispatchTask(
    f.workspace.id,
    worker.id,
    'Independent result'
  )
  f.server.store.reportTask(f.workspace.id, worker.id, {
    dispatchId: dispatch.id,
    outcome: 'success',
    text: 'Ready',
  })
  const saved = await profile(
    "node -e \"console.log('STARTED');setTimeout(()=>console.log('FINISHED'),6000)\"",
    { max_parallel: 2 }
  )
  const [first, response] = await Promise.all([
    start(saved.id),
    request(`/dispatches/${dispatch.id}/verifications`, {
      profile_id: saved.id,
      head_sha: f.baseline,
      report_revision: 1,
    }),
  ])
  expect(response.status, await response.clone().text()).toBe(202)
  const second = await response.json()
  await until(async () => {
    expect(f.server.store.verifications.get(first.id)?.output).toContain('STARTED')
    expect(f.server.store.verifications.get(second.id)?.output).toContain('STARTED')
    expect(f.server.store.resources.getSnapshot().occupancy.by_kind.verification).toBe(2)
  })
  expect(
    (await request(`/dispatches/${f.dispatch.id}/verifications/${first.id}/cancel`, {})).status
  ).toBe(200)
  expect(f.server.store.verifications.get(first.id)?.state).toBe('cancelled')
  expect(f.server.store.verifications.get(second.id)?.state).toBe('running')
  await until(async () =>
    expect(f.server.store.verifications.get(second.id)).toMatchObject({
      state: 'passed',
      output: expect.stringContaining('FINISHED'),
    })
  )
  await until(async () =>
    expect(f.server.store.resources.getSnapshot().occupancy.by_kind.verification).toBe(0)
  )
}, 90000)

test('configured timeout terminates its process and missing environment queues without consuming execution', async () => {
  const { f, request, profile, start } = await setup()
  const timed = await profile('node -e "setInterval(()=>console.log(\'alive\'),100)"', {
    timeout_ms: 1000,
  })
  const run = await start(timed.id)
  await until(async () =>
    expect(f.server.store.verifications.get(run.id)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('1000 ms'),
    })
  )
  await until(async () =>
    expect(f.server.store.resources.getSnapshot().occupancy.by_kind.verification).toBe(0)
  )
  const waiting = await profile('node -e "console.log(\'ready\')"', {
    required_env: ['HIVETEAM_SYNTHETIC_DEPENDENCY'],
  })
  delete process.env.HIVETEAM_SYNTHETIC_DEPENDENCY
  const queued = await start(waiting.id)
  expect(f.server.store.verifications.get(queued.id)?.state).toBe('queued')
  expect(f.server.store.resourceQueue.list(f.workspace.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        reason: 'verification_environment_required: HIVETEAM_SYNTHETIC_DEPENDENCY',
      }),
    ])
  )
  const cancelled = await request(
    `/dispatches/${f.dispatch.id}/verifications/${queued.id}/cancel`,
    {}
  )
  expect(cancelled.status).toBe(200)
  expect(f.server.store.verifications.get(queued.id)?.state).toBe('cancelled')
}, 90000)

test('restricted profiles fail closed on unsupported platforms and profile writes require desktop identity', async () => {
  const { f, request } = await setup()
  const invalid = await request('/verification-profiles', {
    name: 'Invalid',
    command: 'node -e "0"',
    execution: 'trusted_unsafe',
    network: 'none',
  })
  expect(invalid.status).toBe(400)
  const saved = await request('/verification-profiles', {
    name: 'Restricted',
    command: 'node -e "0"',
  })
  expect(saved.status).toBe(201)
  const profile = await saved.json()
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    const response = await request(`/dispatches/${f.dispatch.id}/verifications`, {
      profile_id: profile.id,
      head_sha: f.source,
      report_revision: 1,
    })
    const run = await response.json()
    await until(async () =>
      expect(f.server.store.verifications.get(run.id)).toMatchObject({
        state: 'failed',
        error: expect.stringContaining('Linux x64'),
      })
    )
  }
  const unauthorized = await fetch(
    `${f.server.baseUrl}/api/ui/workspaces/${f.workspace.id}/verification-profiles`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
  )
  expect(unauthorized.status).toBe(403)
}, 90000)
