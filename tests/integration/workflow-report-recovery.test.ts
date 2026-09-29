import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { ConflictError } from '../../src/server/http-errors.js'
import Database from '../../src/server/sqlite.js'
import type { WorkflowRunStep } from '../../src/shared/workflows.js'
import { createCodeReviewFixture } from '../helpers/code-review-fixture.js'

const fixtures: { db: Database; base: Awaited<ReturnType<typeof createCodeReviewFixture>> }[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.db.close()
    await f.base.close()
  }
})
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing recovery fixture value')
  return value
}
interface SavedRun {
  steps_json: string
  status: string
  error: string | null
  ended_at: number | null
  updated_at: number
}
const setup = async (withDependency = false) => {
  const base = await createCodeReviewFixture(false)
  const db = new Database(join(base.server.dataDir, 'runtime.sqlite'))
  const successor = base.server.store.addWorker(base.workspace.id, {
    name: 'Successor',
    role: 'coder',
  })
  base.server.store.configureAgentLaunch(base.workspace.id, successor.id, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  const folder = join(base.project, '.hive', 'workflows')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'recovery.json'),
    JSON.stringify({
      name: 'Report recovery',
      steps: [
        { id: 'A', worker: 'Builder', task: 'Produce a durable report' },
        ...(withDependency
          ? [{ id: 'B', worker: 'Successor', task: 'Use A result', needs: ['A'] }]
          : []),
      ],
    })
  )
  const started = await base.server.store.workflows.start(
    base.workspace.id,
    folder,
    'recovery.json',
    new URL(base.server.baseUrl).port
  )
  const run = () => required(base.server.store.workflows.get(base.workspace.id, started.id))
  const snapshot = () =>
    db
      .prepare('SELECT steps_json,status,error,ended_at,updated_at FROM workflow_runs WHERE id=?')
      .get(started.id) as SavedRun
  const restore = (saved: SavedRun) =>
    db
      .prepare(
        'UPDATE workflow_runs SET steps_json=?,status=?,error=?,ended_at=?,updated_at=? WHERE id=?'
      )
      .run(
        saved.steps_json,
        saved.status,
        saved.error,
        saved.ended_at,
        saved.updated_at,
        started.id
      )
  const report = async (dispatchId: string, workerId: string, outcome?: 'success' | 'blocked') => {
    const response = await fetch(`${base.server.baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: base.workspace.id,
        from_agent_id: workerId,
        token: base.server.store.peekAgentToken(workerId),
        dispatch_id: dispatchId,
        result: 'Durable report content',
        artifacts: ['result.txt'],
        ...(outcome ? { outcome } : {}),
      }),
    })
    expect(response.status).toBe(202)
    expect(base.server.store.getDispatch(base.workspace.id, dispatchId)).toMatchObject({
      status: 'reported',
      reportOutcome: outcome ?? null,
      reportRevision: 1,
    })
  }
  const count = () =>
    (
      db
        .prepare('SELECT COUNT(*) AS count FROM dispatches WHERE workspace_id=?')
        .get(base.workspace.id) as { count: number }
    ).count
  const f = { base, db, run, snapshot, restore, report, count, successor }
  fixtures.push(f)
  return f
}

test('restart reconciles a persisted success before dispatching its dependent exactly once', async () => {
  const f = await setup(true)
  const id = required(f.run().steps[0]?.dispatchId)
  const saved = f.snapshot()
  const count = f.count()
  await f.base.server.store.workflows.close()
  await f.report(id, f.base.worker.id, 'success')
  f.restore(saved)
  await f.base.restart()
  f.base.server.store.workflows.resume(new URL(f.base.server.baseUrl).port)
  await expect.poll(() => f.run().steps[1]?.status, { timeout: 6000 }).toBe('running')
  expect(f.run().steps[0]).toMatchObject({
    status: 'completed',
    reportText: 'Durable report content',
    artifacts: ['result.txt'],
    resultVersion: { attempt: 1, dispatch_id: id, report_revision: 1 },
  })
  const next = required(f.run().steps[1]?.dispatchId)
  expect(f.run().steps[1]?.dependencyVersions?.A).toEqual(f.run().steps[0]?.resultVersion)
  expect(f.count()).toBe(count + 1)
  await f.base.server.store.workflows.refresh(f.base.workspace.id, f.run().id)
  await f.base.server.store.workflows.refresh(f.base.workspace.id, f.run().id)
  expect(f.run().steps[1]?.dispatchId).toBe(next)
  expect(f.count()).toBe(count + 1)
  await f.report(next, f.successor.id, 'success')
  expect(f.run().status).toBe('completed')
}, 30000)

test('a report committed before the submitted callback also recovers a queued workflow step', async () => {
  const f = await setup()
  const id = required(f.run().steps[0]?.dispatchId)
  const saved = f.snapshot()
  saved.steps_json = JSON.stringify(
    (JSON.parse(saved.steps_json) as WorkflowRunStep[]).map((step) => ({
      ...step,
      status: 'queued',
    }))
  )
  const count = f.count()
  await f.base.server.store.workflows.close()
  await f.report(id, f.base.worker.id, 'success')
  f.restore(saved)
  await f.base.restart()
  await f.base.server.store.workflows.refresh(f.base.workspace.id, f.run().id)
  expect(f.run()).toMatchObject({
    status: 'completed',
    steps: [expect.objectContaining({ dispatchId: id, status: 'completed' })],
  })
  expect(f.count()).toBe(count)
}, 30000)

for (const outcome of ['blocked', undefined] as const) {
  test(`recovery preserves ${outcome ?? 'legacy'} report review rules and is idempotent`, async () => {
    const f = await setup()
    const id = required(f.run().steps[0]?.dispatchId)
    const saved = f.snapshot()
    await f.base.server.store.workflows.close()
    await f.report(id, f.base.worker.id, outcome)
    f.restore(saved)
    await f.base.restart()
    await f.base.server.store.workflows.refresh(f.base.workspace.id, f.run().id)
    expect(f.run()).toMatchObject({
      status: 'running',
      steps: [
        expect.objectContaining({
          status: outcome ? 'blocked' : 'awaiting_review',
          resultVersion: null,
          reportText: 'Durable report content',
        }),
      ],
    })
    const waiting = f.snapshot()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await f.base.server.store.workflows.refresh(f.base.workspace.id, f.run().id)
    expect(f.snapshot()).toEqual(waiting)
    if (outcome === 'blocked') {
      expect(() => f.base.server.store.acceptDispatchReport(f.base.workspace.id, id, 1)).toThrow(
        ConflictError
      )
      expect(f.snapshot()).toEqual(waiting)
      expect(f.base.server.store.getDispatch(f.base.workspace.id, id)?.acceptedAt).toBeNull()
      return
    }
    f.base.server.store.acceptDispatchReport(f.base.workspace.id, id, 1)
    f.restore(waiting)
    await f.base.restart()
    await f.base.server.store.workflows.refresh(f.base.workspace.id, f.run().id)
    expect(f.run()).toMatchObject({
      status: 'completed',
      steps: [
        expect.objectContaining({
          status: 'completed',
          resultVersion: expect.objectContaining({
            attempt: 1,
            dispatch_id: id,
            report_revision: 1,
          }),
        }),
      ],
    })
  }, 30000)
}

test('recovery preserves pending rerun intent and cannot apply an older attempt report to its replacement', async () => {
  const f = await setup()
  const id = required(f.run().steps[0]?.dispatchId)
  await f.report(id, f.base.worker.id, 'success')
  const old = required(f.base.server.store.getDispatch(f.base.workspace.id, id))
  await f.base.server.store.workflows.close()
  f.base.server.store.workflows.rerun(
    f.base.workspace.id,
    f.run().id,
    'A',
    1,
    'Use a fresh attempt'
  )
  await f.base.server.store.workflows.refresh(f.base.workspace.id, f.run().id)
  expect(f.run().steps[0]).toMatchObject({
    status: 'blocked',
    rerunPending: true,
    attempt: 1,
    resultVersion: null,
  })
  await f.base.restart()
  f.base.server.store.workflows.resume(new URL(f.base.server.baseUrl).port)
  await expect.poll(() => f.run().steps[0]?.status, { timeout: 6000 }).toBe('running')
  const replacement = required(f.run().steps[0]?.dispatchId)
  expect(replacement).not.toBe(id)
  expect(f.run().steps[0]?.attempt).toBe(2)
  expect(f.base.server.store.workflows.recordDispatchReport(f.base.workspace.id, old)).toBe(false)
  await f.base.server.store.workflows.refresh(f.base.workspace.id, f.run().id)
  expect(f.run().steps[0]).toMatchObject({
    dispatchId: replacement,
    status: 'running',
    resultVersion: null,
  })
}, 30000)
