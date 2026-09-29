import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import Database from '../../src/server/sqlite.js'
import type { WorkflowRun } from '../../src/shared/workflows.js'
import { createCodeReviewFixture } from '../helpers/code-review-fixture.js'

const fixtures: Awaited<ReturnType<typeof createCodeReviewFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing workflow test value')
  return value
}
const setup = async (queuedSecond = false) => {
  const fixture = await createCodeReviewFixture(false)
  fixtures.push(fixture)
  const second = fixture.server.store.addWorker(fixture.workspace.id, {
    name: 'Independent',
    role: 'coder',
  })
  const marker = join(fixture.project, 'received.txt')
  const script = join(fixture.project, 'receiver.cjs')
  await writeFile(marker, '')
  await writeFile(
    script,
    `const fs=require('node:fs');process.stdin.setEncoding('utf8');process.stdin.on('data',text=>fs.appendFileSync(${JSON.stringify(marker)},text));console.log('STOP_WORKER_READY');process.stdin.resume()`
  )
  fixture.server.store.configureAgentLaunch(fixture.workspace.id, second.id, {
    command: process.execPath,
    args: [script],
  })
  if (queuedSecond) fixture.server.store.cancelPendingAgentStart(fixture.workspace.id, second.id)
  const root = join(fixture.project, '.hive', 'workflows')
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'stop.json'),
    JSON.stringify({
      name: 'Stop recovery',
      steps: [
        { id: 'A', worker: 'Builder', task: 'Prepare A' },
        { id: 'B', worker: 'Independent', task: 'Prepare B' },
      ],
    })
  )
  const call = (suffix: string, body: unknown = {}) =>
    fetch(
      `${fixture.server.baseUrl}/api/ui/workspaces/${fixture.workspace.id}/workflows${suffix}`,
      {
        method: 'POST',
        headers: { cookie: fixture.cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
  const response = await call('/runs', { workflow_id: 'stop.json' })
  expect(response.status).toBe(201)
  const started = (await response.json()) as { id: string }
  const run = () => required(fixture.server.store.workflows.get(fixture.workspace.id, started.id))
  for (let pass = 0; pass < 2; pass += 1) {
    for (const step of run().steps) {
      if (!step.dispatchId || step.status !== 'running') continue
      const dispatch = required(
        fixture.server.store.getDispatch(fixture.workspace.id, step.dispatchId)
      )
      const accepted = await fetch(`${fixture.server.baseUrl}/api/team/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: fixture.workspace.id,
          from_agent_id: dispatch.toAgentId,
          token: fixture.server.store.peekAgentToken(dispatch.toAgentId),
          dispatch_id: dispatch.id,
          progress_state: 'accepted',
          result: 'Accepted for stop recovery coverage',
        }),
      })
      expect(accepted.status).toBe(202)
    }
    await fixture.server.store.workflows.refresh(fixture.workspace.id, started.id)
  }
  // refresh can return while the scheduler is already dispatching this run.
  // Wait for the real delivery callbacks before exercising the stop boundary.
  await expect
    .poll(() => run().steps.map((step) => step.status), { timeout: 10000 })
    .toEqual(['running', queuedSecond ? 'queued' : 'running'])
  const ids = run().steps.map((step) => required(step.dispatchId))
  return { fixture, second, call, run, ids, marker }
}
const dispatchStatus = (db: Database, id: string) =>
  (db.prepare('SELECT status FROM dispatches WHERE id=?').get(id) as { status: string }).status
const persistedRun = (db: Database, id: string) =>
  db.prepare('SELECT status,steps_json FROM workflow_runs WHERE id=?').get(id) as {
    status: WorkflowRun['status']
    steps_json: string
  }

test('a failed stop intent write leaves the live workflow and dispatches untouched', async () => {
  const { fixture, call, run, ids } = await setup()
  const db = new Database(join(fixture.dataDir, 'runtime.sqlite'))
  try {
    db.exec(`CREATE TRIGGER stop_intent_failure BEFORE UPDATE ON workflow_runs
      WHEN NEW.status='stopped' BEGIN SELECT RAISE(ABORT, 'stop intent unavailable'); END`)
    expect((await call(`/runs/${run().id}/stop`)).status).toBe(500)
    expect(persistedRun(db, run().id).status).toBe('running')
    expect(run().status).toBe('running')
    expect(ids.map((id) => dispatchStatus(db, id))).toEqual(['submitted', 'submitted'])
    expect(
      ids.map((id) => fixture.server.store.getDispatch(fixture.workspace.id, id)?.status)
    ).toEqual(['submitted', 'submitted'])
    expect(
      fixture.server.store.dispatchDelivery.records
        .list(fixture.workspace.id)
        .filter((record) => record.kind === 'cancel')
    ).toEqual([])
  } finally {
    db.exec('DROP TRIGGER IF EXISTS stop_intent_failure')
    db.close()
  }
}, 90000)

test('partial cancellation failure preserves stopped intent and a repeated stop completes it', async () => {
  const { fixture, call, run, ids } = await setup()
  const db = new Database(join(fixture.dataDir, 'runtime.sqlite'))
  try {
    db.exec(`CREATE TRIGGER stop_cancel_failure BEFORE UPDATE ON dispatches
      WHEN NEW.status='cancelled' AND OLD.id='${required(ids[1])}'
      BEGIN SELECT RAISE(ABORT, 'cancellation unavailable'); END`)
    expect((await call(`/runs/${run().id}/stop`)).status).toBe(500)
    expect(persistedRun(db, run().id).status).toBe('stopped')
    expect(run().steps.map((step) => step.status)).toEqual(['stopped', 'stopped'])
    expect(ids.map((id) => dispatchStatus(db, id))).toEqual(['cancelled', 'submitted'])
    const endedAt = run().endedAt
    db.exec('DROP TRIGGER stop_cancel_failure')
    expect((await call(`/runs/${run().id}/stop`)).status).toBe(200)
    expect(ids.map((id) => dispatchStatus(db, id))).toEqual(['cancelled', 'cancelled'])
    expect(run().status).toBe('stopped')
    expect(run().endedAt).toBe(endedAt)
    expect(
      fixture.server.store.dispatchDelivery.records
        .list(fixture.workspace.id)
        .filter((record) => record.kind === 'cancel')
    ).toHaveLength(2)
  } finally {
    db.exec('DROP TRIGGER IF EXISTS stop_cancel_failure')
    db.close()
  }
}, 90000)

test('restart blocks start and rerun until a failed queued dispatch can finish cancellation', async () => {
  const { fixture, second, call, run, ids, marker } = await setup(true)
  const db = new Database(join(fixture.dataDir, 'runtime.sqlite'))
  try {
    db.exec(`CREATE TRIGGER stop_cancel_failure BEFORE UPDATE ON dispatches
      WHEN NEW.status='cancelled' AND OLD.id='${required(ids[1])}'
      BEGIN SELECT RAISE(ABORT, 'cancellation unavailable'); END`)
    expect((await call(`/runs/${run().id}/stop`)).status).toBe(500)
    createDispatchLedgerStore(db).markDeliveryFailed(required(ids[1]), 'Interrupted delivery')
    expect(dispatchStatus(db, required(ids[1]))).toBe('queued')
    expect(fixture.server.store.getDispatch(fixture.workspace.id, required(ids[1]))?.status).toBe(
      'failed'
    )
    await fixture.restart()
    const start = () =>
      fetch(
        `${fixture.server.baseUrl}/api/workspaces/${fixture.workspace.id}/agents/${second.id}/start`,
        { method: 'POST', headers: { cookie: fixture.cookie } }
      )
    expect((await start()).status).toBe(500)
    expect(
      fixture.server.store.getActiveRunByAgentId(fixture.workspace.id, second.id)
    ).toBeUndefined()
    expect(await readFile(marker, 'utf8')).toBe('')
    expect(
      (
        await call(`/runs/${run().id}/steps/A/rerun`, {
          expected_attempt: 1,
          reason: 'Retry only A after stopping',
        })
      ).status
    ).toBe(500)
    expect(run().status).toBe('stopped')
    expect(run().steps.map((step) => step.attempt)).toEqual([1, 1])
    expect(dispatchStatus(db, required(ids[1]))).toBe('queued')
    db.exec('DROP TRIGGER stop_cancel_failure')
    const response = await start()
    expect(response.status).toBe(201)
    const started = (await response.json()) as { run_id: string }
    await expect
      .poll(() => fixture.server.store.getLiveRun(started.run_id).output, { timeout: 10000 })
      .toContain('STOP_WORKER_READY')
    expect(ids.map((id) => dispatchStatus(db, id))).toEqual(['cancelled', 'cancelled'])
    expect(fixture.server.store.dispatchDelivery.records.get(required(ids[1]))?.state).toBe(
      'resolved'
    )
    await expect
      .poll(() => readFile(marker, 'utf8'), { timeout: 10000 })
      .toContain('Workflow run stopped by the user.')
    expect(await readFile(marker, 'utf8')).not.toContain('Prepare B')
    expect(run().status).toBe('stopped')
    expect(run().steps.map((step) => step.attempt)).toEqual([1, 1])
  } finally {
    db.exec('DROP TRIGGER IF EXISTS stop_cancel_failure')
    db.close()
  }
}, 90000)

test('stop recovery leaves feedback on an already completed historical step open', async () => {
  const { fixture, call, run, ids } = await setup()
  fixture.server.store.reportTask(fixture.workspace.id, fixture.worker.id, {
    dispatchId: required(ids[0]),
    text: 'A is complete',
    outcome: 'success',
  })
  expect(run().steps[0]?.status).toBe('completed')
  expect((await call(`/runs/${run().id}/stop`)).status).toBe(200)
  fixture.server.store.sendDispatchFeedback(
    fixture.workspace.id,
    required(ids[0]),
    'Follow up independently after the workflow stopped'
  )
  expect(fixture.server.store.getDispatch(fixture.workspace.id, required(ids[0]))?.status).toBe(
    'submitted'
  )
  expect((await call(`/runs/${run().id}/stop`)).status).toBe(200)
  await fixture.restart()
  const response = await fetch(
    `${fixture.server.baseUrl}/api/workspaces/${fixture.workspace.id}/agents/${fixture.worker.id}/start`,
    { method: 'POST', headers: { cookie: fixture.cookie } }
  )
  expect(response.status).toBe(201)
  await expect
    .poll(() => fixture.server.store.getDispatch(fixture.workspace.id, required(ids[0]))?.status, {
      timeout: 10000,
    })
    .toBe('submitted')
  expect(run().status).toBe('stopped')
  expect(run().steps.map((step) => step.status)).toEqual(['completed', 'stopped'])
  expect(
    fixture.server.store.dispatchDelivery.records
      .list(fixture.workspace.id)
      .filter((record) => record.kind === 'cancel' && record.dispatch_id === ids[0])
  ).toEqual([])
}, 90000)

test('background recovery completes pending stop cancellation while the worktree is busy', async () => {
  const { fixture, call, run, ids } = await setup(true)
  const db = new Database(join(fixture.dataDir, 'runtime.sqlite'))
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const operation = fixture.server.store.worktrees.exclusive(fixture.workspace.id, () => held)
  try {
    expect(fixture.server.store.worktrees.isBusy(fixture.workspace.id)).toBe(true)
    db.exec(`CREATE TRIGGER stop_cancel_failure BEFORE UPDATE ON dispatches
      WHEN NEW.status='cancelled' AND OLD.id='${required(ids[1])}'
      BEGIN SELECT RAISE(ABORT, 'cancellation unavailable'); END`)
    expect((await call(`/runs/${run().id}/stop`)).status).toBe(500)
    expect(run().status).toBe('stopped')
    expect(dispatchStatus(db, required(ids[1]))).toBe('queued')
    db.exec('DROP TRIGGER stop_cancel_failure')
    await expect
      .poll(() => dispatchStatus(db, required(ids[1])), { timeout: 8000 })
      .toBe('cancelled')
    expect(fixture.server.store.worktrees.isBusy(fixture.workspace.id)).toBe(true)
    expect(run().status).toBe('stopped')
    expect(run().steps.map((step) => step.attempt)).toEqual([1, 1])
  } finally {
    release()
    await operation
    db.exec('DROP TRIGGER IF EXISTS stop_cancel_failure')
    db.close()
  }
}, 90000)
