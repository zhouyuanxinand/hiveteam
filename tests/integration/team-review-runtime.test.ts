import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runGit } from '../../src/server/git-command.js'
import type { TeamReviewView } from '../../src/shared/team-review.js'
import { commitReviewFixture } from '../helpers/code-review-fixture.js'
import { createTeamReviewFixture } from '../helpers/team-review-fixture.js'

const fixtures: Awaited<ReturnType<typeof createTeamReviewFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close()
})
const setup = async () => {
  const fixture = await createTeamReviewFixture()
  fixtures.push(fixture)
  return fixture
}
const child = (review: TeamReviewView) => {
  if (!review.review_dispatch_id) throw new Error(review.last_error ?? 'Review dispatch is missing')
  return review.review_dispatch_id
}

test('real CLI and mailbox bind an isolated review to its source and retain its report, files and pending delivery across retirement and restart', async () => {
  const f = await setup(),
    requestId = randomUUID()
  const mailbox = await f.mailbox()
  const created = await f.cli(
    f.actor,
    [
      'review',
      '--dispatch',
      f.dispatch.id,
      '--cli',
      f.preset.id,
      '--request-id',
      requestId,
      'Inspect frozen source',
    ],
    mailbox
  )
  expect(created.code, created.stderr).toBe(0)
  const review = JSON.parse(created.stdout) as TeamReviewView
  expect(review).toMatchObject({
    id: requestId,
    source_report_revision: 1,
    source_head_sha: f.source,
    stale_reason: null,
  })
  const dispatchId = child(review)
  expect(f.server.store.getDispatch(f.workspace.id, dispatchId)).toMatchObject({
    parentDispatchId: f.dispatch.id,
    rootDispatchId: f.dispatch.id,
    messageProtocolVersion: 1,
  })
  const cwd = review.working_directory
  if (!cwd) throw new Error('Missing review checkout')
  expect(cwd).not.toBe(f.sourcePath)
  expect((await runGit(cwd, ['rev-parse', 'HEAD'])).trim()).toBe(f.source)
  expect(await readFile(join(cwd, 'value.txt'), 'utf8')).toBe('delivered\n')
  await expect
    .poll(() => f.server.store.getActiveRunByAgentId(f.workspace.id, review.reviewer_id)?.output, {
      timeout: 15000,
    })
    .toContain(cwd.replaceAll('\\', '\\\\'))
  const context = await f.cli(review.reviewer_id, [
    'review',
    'context',
    '--dispatch',
    f.dispatch.id,
  ])
  expect(context.code, context.stderr).toBe(0)
  const snapshot = JSON.parse(context.stdout)
  expect(snapshot.version).toMatchObject({
    source_sha: f.source,
    base_sha: f.baseline,
    report_revision: 1,
  })
  expect(snapshot.patch).toContain('+delivered')
  // Findings are preserved even if a reviewer leaves files outside the committed snapshot.
  await writeFile(join(cwd, 'notes.txt'), 'retained reviewer notes')
  await f.server.store.dispatchDelivery.close()
  const report = await f.cli(review.reviewer_id, [
    'report',
    'Frozen commit reviewed',
    '--dispatch',
    dispatchId,
    '--outcome',
    'success',
    '--artifact',
    'notes.txt',
  ])
  expect(report.code, report.stderr).toBe(0)
  const outbox = f.db((db) =>
    db.prepare('SELECT * FROM report_outbox WHERE dispatch_id=?').get(dispatchId)
  )
  expect(outbox).toMatchObject({ delivered_at: null })
  await expect
    .poll(() => f.server.store.getWorker(f.workspace.id, review.reviewer_id).retiredAt, {
      timeout: 12000,
    })
    .toEqual(expect.any(Number))
  expect(
    f.db((db) => db.prepare('SELECT * FROM report_outbox WHERE dispatch_id=?').get(dispatchId))
  ).toEqual(outbox)
  expect(f.server.store.getDispatch(f.workspace.id, f.dispatch.id)).toMatchObject({
    status: 'reported',
    reportRevision: 1,
    acceptedAt: null,
    reportText: 'Ready for review',
  })
  expect((await f.server.store.verifications.view(f.workspace.id, f.dispatch.id)).runs).toEqual([])
  expect((await f.context()).accepted).toBe(false)
  await f.restart()
  const restored = await f.server.store.teamReviews.get(f.workspace.id, requestId)
  expect(restored).toMatchObject({
    state: 'reported',
    report_text: 'Frozen commit reviewed',
    worktree_dirty: true,
    reviewer_retired_at: expect.any(Number),
    working_directory: cwd,
  })
  expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('retained reviewer notes')
  const resumed = await f.server.store.autoResumeInterruptedAgents({
    hivePort: new URL(f.server.baseUrl).port,
  })
  expect(resumed.some((item) => item.agentId === review.reviewer_id)).toBe(false)
  if (!f.server.store.getActiveRunByAgentId(f.workspace.id, f.actor))
    await f.server.store.startAgent(f.workspace.id, f.actor, {
      hivePort: new URL(f.server.baseUrl).port,
    })
  await expect
    .poll(() => f.server.store.getActiveRunByAgentId(f.workspace.id, f.actor)?.output, {
      timeout: 20000,
    })
    .toContain('Frozen commit reviewed')
  expect(f.server.store.getDispatch(f.workspace.id, dispatchId)?.reportText).toBe(
    'Frozen commit reviewed'
  )
}, 120000)

test('queued reviewer starts at the assigned commit after source HEAD moves and cannot substitute the new version', async () => {
  const f = await setup()
  f.server.store.resources.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
  const review = await f.create()
  expect(review.state).toBe('queued')
  expect(f.server.store.getActiveRunByAgentId(f.workspace.id, review.reviewer_id)).toBeUndefined()
  await writeFile(join(f.sourcePath, 'value.txt'), 'new source version\n')
  const moved = await commitReviewFixture(f.sourcePath, 'Source advances during review queue')
  expect(moved).not.toBe(f.source)
  f.server.store.resources.updateLimits({ max_running_total: 2 }, { actor: 'local_user' })
  await expect
    .poll(() => f.server.store.getActiveRunByAgentId(f.workspace.id, review.reviewer_id)?.output, {
      timeout: 20000,
    })
    .toContain('REVIEW_READY:')
  const cwd = review.working_directory
  if (!cwd) throw new Error('Missing checkout')
  expect((await runGit(cwd, ['rev-parse', 'HEAD'])).trim()).toBe(f.source)
  expect(await readFile(join(cwd, 'value.txt'), 'utf8')).toBe('delivered\n')
  expect(await f.server.store.teamReviews.get(f.workspace.id, review.id)).toMatchObject({
    stale_reason: 'code_changed',
    source_head_sha: f.source,
  })
  const context = await f.cli(review.reviewer_id, [
    'review',
    'context',
    '--dispatch',
    f.dispatch.id,
  ])
  expect(context.code, context.stderr).toBe(0)
  expect(JSON.parse(context.stdout)).toMatchObject({
    version: { source_sha: f.source },
    source_stale_reason: 'code_changed',
  })
  const version = (await f.context()).version
  expect(
    (
      await f.post(
        '/api/team/review/submit',
        {
          dispatch_id: f.dispatch.id,
          request_id: randomUUID(),
          version,
          conclusion: 'approve',
          summary: 'Cannot substitute current source',
        },
        review.reviewer_id
      )
    ).status
  ).toBe(409)
  const reported = await f.post(
    '/api/team/report',
    { dispatch_id: child(review), result: 'Findings for the original commit', outcome: 'success' },
    review.reviewer_id
  )
  expect(reported.status, await reported.clone().text()).toBe(202)
  await expect
    .poll(() => f.server.store.getWorker(f.workspace.id, review.reviewer_id).retiredAt, {
      timeout: 12000,
    })
    .toEqual(expect.any(Number))
  expect((await f.context()).reviews).toEqual([])
  // Retirement is recorded before native PTY exit releases the execution slot.
  // Wait for that observable completion before admitting the source worker.
  await expect
    .poll(() => f.server.store.resources.getSnapshot().occupancy.global, { timeout: 12000 })
    .toBe(1)
  // A later report revision invalidates the old review independently of its SHA.
  await f.server.store.startAgent(f.workspace.id, f.worker.id, {
    hivePort: new URL(f.server.baseUrl).port,
  })
  f.server.store.sendDispatchFeedback(f.workspace.id, f.dispatch.id, 'Report the new source')
  f.server.store.reportTask(f.workspace.id, f.worker.id, {
    dispatchId: f.dispatch.id,
    text: 'Revised report',
    outcome: 'success',
  })
  expect(await f.server.store.teamReviews.get(f.workspace.id, review.id)).toMatchObject({
    stale_reason: 'report_changed',
    source_report_revision: 1,
    report_text: 'Findings for the original commit',
  })
}, 120000)

test('concurrent retries reuse one review, startup failure leaves the source intact, and explicit cancellation retires only the reviewer', async () => {
  const f = await setup()
  const bad = f.server.store.settings.createCommandPreset({
    command: join(f.root, 'missing-review-cli'),
    args: [],
    displayName: 'Unavailable fixture',
    env: {},
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: null,
  })
  f.server.store.workerLifecycle.updatePolicy(f.workspace.id, {
    enabled: true,
    allowed_command_preset_ids: [bad.id],
    max_ephemeral_workers: 1,
  })
  const body = f.requestBody({ command_preset_id: bad.id })
  const [a, b] = await Promise.all([
    f.post('/api/team/review/request', body),
    f.post('/api/team/review/request', body),
  ])
  expect([a.status, b.status]).toEqual([201, 201])
  const first = (await a.json()) as TeamReviewView,
    second = (await b.json()) as TeamReviewView
  expect(second).toMatchObject({
    id: first.id,
    reviewer_id: first.reviewer_id,
    review_dispatch_id: first.review_dispatch_id,
  })
  expect(first).toMatchObject({ state: 'failed', last_error: expect.any(String) })
  expect(
    f.db((db) => db.prepare('SELECT COUNT(*) AS count FROM team_review_requests').get())
  ).toEqual({ count: 1 })
  expect(
    f.server.store.listWorkers(f.workspace.id).filter((worker) => worker.role === 'reviewer')
  ).toHaveLength(1)
  expect(
    (await f.post('/api/team/review/request', { ...body, focus: 'Changed request' })).status
  ).toBe(409)
  expect(f.server.store.getDispatch(f.workspace.id, f.dispatch.id)).toMatchObject({
    status: 'reported',
    reportRevision: 1,
    acceptedAt: null,
  })
  expect(
    (
      await f.post('/api/team/cancel', {
        dispatch_id: child(first),
        reason: 'CLI unavailable; keep diagnostic evidence',
      })
    ).status
  ).toBe(202)
  await expect
    .poll(() => f.server.store.getWorker(f.workspace.id, first.reviewer_id).retiredAt, {
      timeout: 12000,
    })
    .toEqual(expect.any(Number))
  expect(f.server.store.getDispatch(f.workspace.id, f.dispatch.id)?.status).toBe('reported')
}, 90000)

test('policy, role, uncommitted source and cross-workspace checks reject admission without reserving reviewers', async () => {
  const f = await setup()
  f.server.store.workerLifecycle.updatePolicy(f.workspace.id, {
    enabled: false,
    allowed_command_preset_ids: [f.preset.id],
    max_ephemeral_workers: 2,
  })
  expect((await f.post('/api/team/review/request', f.requestBody())).status).toBe(403)
  f.server.store.workerLifecycle.updatePolicy(f.workspace.id, {
    enabled: true,
    allowed_command_preset_ids: [f.preset.id],
    max_ephemeral_workers: 2,
  })
  expect(
    (await f.post('/api/team/review/request', f.requestBody({ command_preset_id: 'codex' }))).status
  ).toBe(403)
  await f.server.store.startAgent(f.workspace.id, f.worker.id, {
    hivePort: new URL(f.server.baseUrl).port,
  })
  expect((await f.post('/api/team/review/request', f.requestBody(), f.worker.id)).status).toBe(403)
  const other = f.server.store.createWorkspace(f.project, 'Other workspace')
  const otherWorker = f.server.store.addWorker(other.id, { name: 'Other', role: 'coder' })
  const otherDispatch = await f.server.store.dispatchTask(other.id, otherWorker.id, 'Other source')
  expect(
    (await f.post('/api/team/review/request', f.requestBody({ dispatch_id: otherDispatch.id })))
      .status
  ).toBe(404)
  await writeFile(join(f.sourcePath, 'dirty.txt'), 'uncommitted')
  expect((await f.post('/api/team/review/request', f.requestBody())).status).toBe(409)
  expect(f.db((db) => db.prepare('SELECT * FROM team_review_requests').all())).toEqual([])
  expect(f.server.store.listWorkers(f.workspace.id).map((worker) => worker.id)).toEqual([
    f.worker.id,
  ])
}, 90000)

test('a changed queued review checkout is refused before PTY launch and its files remain inspectable', async () => {
  const f = await setup()
  f.server.store.resources.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
  const review = await f.create()
  const cwd = review.working_directory
  if (!cwd) throw new Error('Missing checkout')
  await writeFile(join(cwd, 'local.txt'), 'manual inspection edit')
  f.server.store.resources.updateLimits({ max_running_total: 2 }, { actor: 'local_user' })
  await expect(
    f.server.store.startAgent(f.workspace.id, review.reviewer_id, {
      hivePort: new URL(f.server.baseUrl).port,
    })
  ).rejects.toThrow('review checkout changed')
  expect(f.server.store.getActiveRunByAgentId(f.workspace.id, review.reviewer_id)).toBeUndefined()
  expect(await f.server.store.teamReviews.get(f.workspace.id, review.id)).toMatchObject({
    worktree_dirty: true,
    source_head_sha: f.source,
  })
  expect(await readFile(join(cwd, 'local.txt'), 'utf8')).toBe('manual inspection edit')
  expect(f.server.store.getDispatch(f.workspace.id, f.dispatch.id)?.status).toBe('reported')
}, 90000)

test('restart exposes interrupted admission without launching an unassigned reviewer or discarding its checkout', async () => {
  const f = await setup()
  f.server.store.resources.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
  const review = await f.create()
  if (!review.working_directory) throw new Error('Missing checkout')
  await writeFile(
    join(review.working_directory, 'inspection.txt'),
    'keep interrupted review evidence'
  )
  // Restore the durable crash boundary: ownership and checkout exist, no child has committed.
  // The FK clears review_dispatch_id; all reads after restart use the persisted state.
  f.db((db) => db.prepare('DELETE FROM dispatches WHERE id=?').run(child(review)))
  await f.restart()
  const response = await fetch(
    `${f.server.baseUrl}/api/ui/workspaces/${f.workspace.id}/review-requests/${review.id}`,
    { headers: { cookie: f.cookie } }
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    state: 'failed',
    review_dispatch_id: null,
    last_error: expect.stringContaining('interrupted'),
    working_directory: review.working_directory,
    worktree_dirty: true,
  })
  expect(f.server.store.getWorker(f.workspace.id, review.reviewer_id)).toMatchObject({
    preparationState: 'failed',
  })
  await expect(
    f.server.store.startAgent(f.workspace.id, review.reviewer_id, {
      hivePort: new URL(f.server.baseUrl).port,
    })
  ).rejects.toThrow('preparation')
  expect(f.server.store.getActiveRunByAgentId(f.workspace.id, review.reviewer_id)).toBeUndefined()
  expect(await readFile(join(review.working_directory, 'inspection.txt'), 'utf8')).toBe(
    'keep interrupted review evidence'
  )
  expect(f.server.store.getDispatch(f.workspace.id, f.dispatch.id)).toMatchObject({
    status: 'reported',
    acceptedAt: null,
  })
  const retired = f.server.store.workerLifecycle.dismiss(f.workspace.id, review.reviewer_id)
  expect(retired.retired_at).toEqual(expect.any(Number))
  expect(await f.server.store.teamReviews.get(f.workspace.id, review.id)).toMatchObject({
    reviewer_retired_at: retired.retired_at,
    working_directory: review.working_directory,
  })
}, 90000)
