import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createMessageDeliveryStore } from '../../src/server/message-delivery-store.js'
import Database from '../../src/server/sqlite.js'
import { createCodeReviewFixture } from '../helpers/code-review-fixture.js'

const fixtures: Awaited<ReturnType<typeof createCodeReviewFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing delivery recovery fixture value')
  return value
}
const setup = async (
  beforeStart?: (
    fixture: Awaited<ReturnType<typeof createCodeReviewFixture>>,
    db: Database
  ) => void | Promise<void>,
  quality = false,
  single = false
) => {
  const f = await createCodeReviewFixture(false)
  fixtures.push(f)
  const marker = join(f.project, 'received.txt')
  const script = join(f.project, 'receiver.cjs')
  await writeFile(marker, '')
  await writeFile(
    script,
    `const fs=require('node:fs');process.stdin.setEncoding('utf8');process.stdin.on('data',text=>fs.appendFileSync(${JSON.stringify(marker)},text));console.log('RECOVERY_READY');process.stdin.resume()`
  )
  f.server.store.configureAgentLaunch(f.workspace.id, f.worker.id, {
    command: process.execPath,
    args: [script],
  })
  const next = f.server.store.addWorker(f.workspace.id, { name: 'Next', role: 'coder' })
  f.server.store.configureAgentLaunch(f.workspace.id, next.id, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  const root = join(f.project, '.hive', 'workflows')
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'delivery.json'),
    JSON.stringify({
      name: 'Delivery recovery',
      steps: [
        {
          id: 'A',
          worker: 'Builder',
          task: 'DELIVERY_RECOVERY_ORIGINAL',
          ...(quality ? { quality: { all_of: ['report_success', 'review_accepted'] } } : {}),
        },
        ...(single ? [] : [{ id: 'B', worker: 'Next', task: 'Consume A', needs: ['A'] }]),
      ],
    })
  )
  const db = new Database(join(f.dataDir, 'runtime.sqlite'))
  await beforeStart?.(f, db)
  const request = (path: string, body?: unknown) =>
    fetch(`${f.server.baseUrl}/api/ui/workspaces/${f.workspace.id}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: f.cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  try {
    const response = await request('/workflows/runs', { workflow_id: 'delivery.json' })
    expect(response.status).toBe(201)
    const started = (await response.json()) as { id: string }
    const run = () => required(f.server.store.workflows.get(f.workspace.id, started.id))
    const dispatchId = required(run().steps[0]?.dispatchId)
    const refresh = () => f.server.store.workflows.refresh(f.workspace.id, started.id)
    const get = async () => (await request(`/workflows/runs/${started.id}`)).json()
    return { f, db, marker, request, run, dispatchId, refresh, get, next }
  } catch (error) {
    db.close()
    throw error
  }
}

test('unknown PTY delivery persists interruption across restart, never repastes, and worker acknowledgement resumes the same attempt', async () => {
  const f = await setup()
  try {
    await expect
      .poll(() => f.f.server.store.dispatchDelivery.records.get(f.dispatchId)?.state)
      .toBe('unknown')
    await f.refresh()
    expect(await f.get()).toMatchObject({
      status: 'interrupted',
      needs_attention: true,
      recovery_issues: [
        {
          step_id: 'A',
          dispatch_id: f.dispatchId,
          delivery_id: f.dispatchId,
          reason: 'delivery_unknown',
        },
      ],
    })
    expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(f.run().id)).toEqual({
      status: 'interrupted',
    })
    expect(f.run().steps[1]?.dispatchId).toBeNull()
    await expect
      .poll(() => readFile(f.marker, 'utf8'), { timeout: 8000 })
      .toContain('DELIVERY_RECOVERY_ORIGINAL')
    const received = await readFile(f.marker, 'utf8')
    const recheck = await f.request(`/message-deliveries/${f.dispatchId}/resolve`, {
      action: 'recheck',
    })
    expect(recheck.status).toBe(200)
    expect(await recheck.json()).toEqual({ confirmed: false })
    expect(f.f.server.store.dispatchDelivery.records.get(f.dispatchId)?.state).toBe('unknown')
    expect(await readFile(f.marker, 'utf8')).toBe(received)
    await f.f.restart()
    await f.refresh()
    await f.f.server.store.startAgent(f.f.workspace.id, f.f.worker.id, {
      hivePort: new URL(f.f.server.baseUrl).port,
    })
    await f.refresh()
    expect(await readFile(f.marker, 'utf8')).toBe(received)
    expect(f.run().steps[0]).toMatchObject({ attempt: 1, dispatchId: f.dispatchId })
    const response = await fetch(`${f.f.server.baseUrl}/api/team/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: f.f.workspace.id,
        from_agent_id: f.f.worker.id,
        token: f.f.server.store.peekAgentToken(f.f.worker.id),
        dispatch_id: f.dispatchId,
        progress_state: 'accepted',
        result: 'Accepted this dispatch',
      }),
    })
    expect(response.status).toBe(202)
    await f.refresh()
    expect(await f.get()).toMatchObject({
      status: 'running',
      needs_attention: false,
      recovery_issues: [],
    })
    expect(f.run().steps[0]).toMatchObject({
      attempt: 1,
      dispatchId: f.dispatchId,
      status: 'running',
    })
  } finally {
    f.db.close()
  }
}, 30000)

test('a pre-write failure remains safely queued under its original binding instead of failing the workflow', async () => {
  const f = await setup((_fixture, db) => {
    db.exec(
      "CREATE TRIGGER reject_workflow_payload BEFORE INSERT ON delivery_payload_measurements BEGIN SELECT RAISE(ABORT, 'injected prewrite failure'); END"
    )
  })
  try {
    expect(f.f.server.store.getDispatch(f.f.workspace.id, f.dispatchId)?.status).toBe('failed')
    expect(f.f.server.store.dispatchDelivery.records.get(f.dispatchId)).toMatchObject({
      state: 'pending',
      write_started: 0,
    })
    await f.refresh()
    expect(await f.get()).toMatchObject({
      status: 'running',
      needs_attention: false,
      recovery_issues: [],
    })
    expect(await readFile(f.marker, 'utf8')).not.toContain('DELIVERY_RECOVERY_ORIGINAL')
    f.db.exec('DROP TRIGGER reject_workflow_payload')
    await expect
      .poll(() => f.f.server.store.dispatchDelivery.records.get(f.dispatchId)?.state, {
        timeout: 6000,
      })
      .toBe('unknown')
    await f.refresh()
    expect(f.run().status).toBe('interrupted')
    expect(f.run().steps[0]).toMatchObject({ attempt: 1, dispatchId: f.dispatchId })
  } finally {
    f.db.exec('DROP TRIGGER IF EXISTS reject_workflow_payload')
    f.db.close()
  }
}, 30000)

const postTeam = (
  f: Awaited<ReturnType<typeof setup>>,
  path: 'status' | 'report',
  body: Record<string, unknown>
) =>
  fetch(`${f.f.server.baseUrl}/api/team/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: f.f.workspace.id,
      from_agent_id: f.f.worker.id,
      token: f.f.server.store.peekAgentToken(f.f.worker.id),
      dispatch_id: f.dispatchId,
      result: 'Accepted this dispatch',
      ...body,
    }),
  })
const resolveDelivery = (
  f: Awaited<ReturnType<typeof setup>>,
  id: string,
  action: 'handled' | 'resend'
) =>
  f.request(`/message-deliveries/${id}/resolve`, {
    action,
    reason: 'Reviewed the actual recipient',
    composer_safe: true,
    ...(action === 'resend' ? { acknowledge_resend: true } : {}),
  })

test('manual recovery survives restart, handled keeps the original responsibility, and repeated refresh is idempotent', async () => {
  const f = await setup((fixture) =>
    fixture.server.store.cancelPendingAgentStart(fixture.workspace.id, fixture.worker.id)
  )
  try {
    f.db
      .prepare(
        "UPDATE message_deliveries SET state='manual',reason='Attempts require operator review' WHERE id=?"
      )
      .run(f.dispatchId)
    await f.f.restart()
    await f.refresh()
    expect(await f.get()).toMatchObject({
      status: 'interrupted',
      recovery_issues: [{ reason: 'delivery_manual', delivery_id: f.dispatchId }],
    })
    expect((await resolveDelivery(f, f.dispatchId, 'handled')).status).toBe(200)
    await f.refresh()
    expect(await f.get()).toMatchObject({
      status: 'running',
      recovery_issues: [],
      needs_attention: false,
    })
    expect(f.run().steps[0]).toMatchObject({
      attempt: 1,
      dispatchId: f.dispatchId,
      status: 'running',
    })
    const snapshot = f.db
      .prepare('SELECT steps_json,status,updated_at FROM workflow_runs WHERE id=?')
      .get(f.run().id)
    await f.refresh()
    expect(
      f.db
        .prepare('SELECT steps_json,status,updated_at FROM workflow_runs WHERE id=?')
        .get(f.run().id)
    ).toEqual(snapshot)
    expect(await readFile(f.marker, 'utf8')).toBe('')
  } finally {
    f.db.close()
  }
}, 30000)

test('explicit resend is the only path that writes a second copy and retains the same dispatch and attempt', async () => {
  const f = await setup()
  try {
    await expect
      .poll(() => readFile(f.marker, 'utf8'), { timeout: 8000 })
      .toContain('DELIVERY_RECOVERY_ORIGINAL')
    await f.refresh()
    const original = f.f.server.store.dispatchDelivery.records.get(f.dispatchId)?.attempt
    const denied = await f.request(`/message-deliveries/${f.dispatchId}/resolve`, {
      action: 'resend',
      reason: 'Retry',
      composer_safe: true,
    })
    expect(denied.status).toBe(400)
    expect((await resolveDelivery(f, f.dispatchId, 'resend')).status).toBe(200)
    await expect
      .poll(
        async () =>
          (await readFile(f.marker, 'utf8')).split('DELIVERY_RECOVERY_ORIGINAL').length - 1,
        { timeout: 8000 }
      )
      .toBe(2)
    await f.refresh()
    expect(f.f.server.store.dispatchDelivery.records.get(f.dispatchId)?.attempt).toBe(
      required(original) + 1
    )
    expect(f.run().steps[0]).toMatchObject({ attempt: 1, dispatchId: f.dispatchId })
    expect(f.run().status).toBe('interrupted')
    expect((await postTeam(f, 'status', { progress_state: 'accepted' })).status).toBe(202)
    await f.refresh()
    expect(f.run().status).toBe('running')
  } finally {
    f.db.close()
  }
}, 30000)

test('a pending step exposes its actual older recipient blocker without adopting that dispatch as its attempt', async () => {
  let blockerId = ''
  const f = await setup(async (fixture) => {
    const blocker = await fixture.server.store.dispatchTask(
      fixture.workspace.id,
      fixture.worker.id,
      'OLDER_INDEPENDENT_RESPONSIBILITY',
      {
        fromAgentId: `${fixture.workspace.id}:orchestrator`,
        hivePort: new URL(fixture.server.baseUrl).port,
      }
    )
    blockerId = blocker.id
  })
  try {
    expect(f.f.server.store.dispatchDelivery.records.get(blockerId)?.state).toBe('unknown')
    expect(f.f.server.store.dispatchDelivery.records.get(f.dispatchId)?.state).toBe('pending')
    const records = createMessageDeliveryStore(f.db)
    expect(records.claim(f.dispatchId, 'blocked-claim-probe')).toBeUndefined()
    expect(records.get(f.dispatchId)).toMatchObject({ state: 'pending', attempt: 0 })
    await f.refresh()
    expect(await f.get()).toMatchObject({
      status: 'interrupted',
      recovery_issues: [
        {
          step_id: 'A',
          dispatch_id: blockerId,
          delivery_id: blockerId,
          reason: 'delivery_blocked',
        },
      ],
    })
    expect(f.run().steps[0]?.dispatchId).toBe(f.dispatchId)
    expect((await resolveDelivery(f, blockerId, 'handled')).status).toBe(200)
    await expect.poll(() => records.get(f.dispatchId)?.state, { timeout: 8000 }).toBe('unknown')
    await f.refresh()
    expect(await f.get()).toMatchObject({
      recovery_issues: [
        { dispatch_id: f.dispatchId, delivery_id: f.dispatchId, reason: 'delivery_unknown' },
      ],
    })
    expect(f.run().steps[0]?.attempt).toBe(1)
  } finally {
    f.db.close()
  }
}, 30000)

test('safe pending delivery waits through restart without creating another dispatch', async () => {
  const f = await setup((fixture) =>
    fixture.server.store.cancelPendingAgentStart(fixture.workspace.id, fixture.worker.id)
  )
  try {
    await f.f.restart()
    await f.refresh()
    expect(await f.get()).toMatchObject({
      status: 'running',
      needs_attention: false,
      recovery_issues: [],
    })
    expect(f.f.server.store.dispatchDelivery.records.get(f.dispatchId)).toMatchObject({
      state: 'pending',
      attempt: 0,
    })
    expect(f.run().steps[0]).toMatchObject({
      dispatchId: f.dispatchId,
      attempt: 1,
      status: 'queued',
    })
    expect(f.run().steps[1]?.dispatchId).toBeNull()
    expect(await readFile(f.marker, 'utf8')).toBe('')
  } finally {
    f.db.close()
  }
}, 30000)

test('unknown report notification does not interrupt reported work or bypass its quality conditions', async () => {
  const f = await setup(undefined, true)
  try {
    const orchestrator = `${f.f.workspace.id}:orchestrator`
    f.f.server.store.configureAgentLaunch(f.f.workspace.id, orchestrator, {
      command: process.execPath,
      args: [join(f.f.project, 'receiver.cjs')],
    })
    await f.f.server.store.startAgent(f.f.workspace.id, orchestrator, {
      hivePort: new URL(f.f.server.baseUrl).port,
    })
    expect(
      (await postTeam(f, 'report', { result: 'Reported with durable output', outcome: 'success' }))
        .status
    ).toBe(202)
    await expect
      .poll(
        () =>
          f.f.server.store.dispatchDelivery.records
            .list(f.f.workspace.id)
            .find((entry) => entry.dispatch_id === f.dispatchId && entry.kind === 'report')?.state,
        { timeout: 8000 }
      )
      .toBe('unknown')
    await f.refresh()
    expect(await f.get()).toMatchObject({
      status: 'running',
      needs_attention: false,
      recovery_issues: [],
    })
    expect(f.run().steps[0]).toMatchObject({
      status: 'awaiting_review',
      waitingFor: ['review_accepted'],
    })
    f.f.server.store.acceptDispatchReport(f.f.workspace.id, f.dispatchId, 1)
    await f.refresh()
    expect(f.run().steps[0]?.status).toBe('awaiting_review')
    expect(f.run().steps[1]?.dispatchId).toBeNull()
  } finally {
    f.db.close()
  }
}, 30000)

test('a cancel receipt cannot release a rerun until execution cancellation is acknowledged', async () => {
  const f = await setup()
  try {
    expect((await postTeam(f, 'status', { progress_state: 'accepted' })).status).toBe(202)
    await f.refresh()
    expect(
      (
        await f.request(`/workflows/runs/${f.run().id}/steps/A/rerun`, {
          expected_attempt: 1,
          reason: 'Start a revised attempt',
        })
      ).status
    ).toBe(202)
    const cancellation = () =>
      f.f.server.store.dispatchDelivery.records
        .list(f.f.workspace.id)
        .find((entry) => entry.dispatch_id === f.dispatchId && entry.kind === 'cancel')
    await expect.poll(() => cancellation()?.state, { timeout: 8000 }).toBe('unknown')
    await f.refresh()
    expect(await f.get()).toMatchObject({
      status: 'interrupted',
      recovery_issues: [{ reason: 'cancellation_unconfirmed' }],
    })
    expect((await resolveDelivery(f, required(cancellation()).id, 'handled')).status).toBe(200)
    await f.refresh()
    expect(f.run().steps[0]).toMatchObject({
      attempt: 1,
      dispatchId: f.dispatchId,
      rerunPending: true,
    })
    expect(
      f.f.server.store.dispatchDelivery.health.get(f.dispatchId)?.cancellation_confirmed_at
    ).toBeNull()
    expect(
      (
        await f.request(`/dispatches/${f.dispatchId}/cancellation-confirmation`, {
          reason: 'Observed the stopped execution',
          acknowledge_stopped: true,
        })
      ).status
    ).toBe(200)
    await f.refresh()
    await expect.poll(() => f.run().steps[0]?.attempt, { timeout: 8000 }).toBe(2)
    const replacement = required(f.run().steps[0]?.dispatchId)
    expect(replacement).not.toBe(f.dispatchId)
    await f.refresh()
    expect(await f.get()).toMatchObject({
      recovery_issues: [{ reason: 'delivery_unknown', dispatch_id: replacement }],
    })
    expect(
      (await postTeam(f, 'report', { result: 'Late old result', outcome: 'success' })).status
    ).toBe(202)
    expect(f.run().steps[0]).toMatchObject({
      attempt: 2,
      dispatchId: replacement,
      status: 'running',
      resultVersion: null,
    })
  } finally {
    f.db.close()
  }
}, 30000)

test.each([
  true,
  false,
])('success clears resolved interruption when the final ordinary step completes (single=%s)', async (single) => {
  const f = await setup(undefined, false, single)
  try {
    await f.refresh()
    expect(f.run().status).toBe('interrupted')
    expect(f.run().error).toContain('Workflow interrupted')
    expect(
      (await postTeam(f, 'report', { result: 'Completed A', outcome: 'success' })).status
    ).toBe(202)
    if (!single) {
      await expect
        .poll(() => f.run().steps[1]?.dispatchId, { timeout: 8000 })
        .toEqual(expect.any(String))
      const last = required(f.run().steps[1]?.dispatchId)
      await expect
        .poll(() => f.f.server.store.dispatchDelivery.records.get(last)?.state, { timeout: 8000 })
        .toBe('unknown')
      await f.refresh()
      expect(f.run().status).toBe('interrupted')
      const response = await fetch(`${f.f.server.baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: f.f.workspace.id,
          from_agent_id: f.next.id,
          token: f.f.server.store.peekAgentToken(f.next.id),
          dispatch_id: last,
          result: 'Completed B',
          outcome: 'success',
        }),
      })
      expect(response.status).toBe(202)
    }
    expect(await f.get()).toMatchObject({
      status: 'completed',
      error: null,
      recovery_issues: [],
      needs_attention: false,
    })
    expect(
      f.db.prepare('SELECT status,error FROM workflow_runs WHERE id=?').get(f.run().id)
    ).toEqual({ status: 'completed', error: null })
  } finally {
    f.db.close()
  }
}, 30000)

test.each([
  0, 1,
])('restart reconciles an interrupted delivery write checkpoint without another workflow attempt (write_started=%s)', async (writeStarted) => {
  const f = await setup(
    writeStarted
      ? undefined
      : (fixture) =>
          fixture.server.store.cancelPendingAgentStart(fixture.workspace.id, fixture.worker.id)
  )
  try {
    if (writeStarted)
      await expect
        .poll(() => readFile(f.marker, 'utf8'), { timeout: 8000 })
        .toContain('DELIVERY_RECOVERY_ORIGINAL')
    const received = await readFile(f.marker, 'utf8')
    // Preserve the SQLite checkpoint that would remain if the process ended before settling its attempt.
    f.db
      .prepare("UPDATE message_deliveries SET state='attempting',write_started=? WHERE id=?")
      .run(writeStarted, f.dispatchId)
    await f.f.restart()
    await f.refresh()
    expect(f.f.server.store.dispatchDelivery.records.get(f.dispatchId)?.state).toBe(
      writeStarted ? 'unknown' : 'pending'
    )
    expect(f.run()).toMatchObject({ status: writeStarted ? 'interrupted' : 'running' })
    expect(f.run().steps[0]).toMatchObject({ attempt: 1, dispatchId: f.dispatchId })
    expect(f.run().steps[1]?.dispatchId).toBeNull()
    expect(await readFile(f.marker, 'utf8')).toBe(received)
    expect(
      f.db.prepare('SELECT dispatch_id FROM workflow_step_attempts WHERE run_id=?').all(f.run().id)
    ).toEqual([{ dispatch_id: f.dispatchId }, { dispatch_id: null }])
  } finally {
    f.db.close()
  }
}, 30000)

test('an independently cancelled current dispatch interrupts its workflow until an explicit stop', async () => {
  const f = await setup()
  try {
    f.f.server.store.cancelTask(f.f.workspace.id, f.dispatchId, {
      fromAgentId: `${f.f.workspace.id}:orchestrator`,
      reason: 'Cancel this execution independently',
    })
    await f.refresh()
    expect(await f.get()).toMatchObject({
      status: 'interrupted',
      recovery_issues: [{ step_id: 'A', dispatch_id: f.dispatchId, reason: 'dispatch_cancelled' }],
    })
    expect(f.run().steps[0]?.attempt).toBe(1)
    expect(f.run().steps[1]?.dispatchId).toBeNull()
    expect((await f.request(`/workflows/runs/${f.run().id}/stop`, {})).status).toBe(200)
    await f.refresh()
    expect(await f.get()).toMatchObject({
      status: 'stopped',
      recovery_issues: [],
      needs_attention: false,
    })
    expect(f.f.server.store.getDispatch(f.f.workspace.id, f.dispatchId)?.status).toBe('cancelled')
  } finally {
    f.db.close()
  }
}, 30000)
