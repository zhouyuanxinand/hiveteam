import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { WorkflowRun } from '../../src/shared/workflows.js'
import { commitReviewFixture, createCodeReviewFixture } from '../helpers/code-review-fixture.js'

const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing expected test fixture value')
  return value
}

const fixtures: Awaited<ReturnType<typeof createCodeReviewFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
const until = async (check: () => void | Promise<void>) => {
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
const setup = async (steps: unknown[]) => {
  const f = await createCodeReviewFixture()
  fixtures.push(f)
  for (const name of ['Downstream', 'Independent']) {
    const worker = f.server.store.addWorker(f.workspace.id, { name, role: 'coder' })
    f.server.store.configureAgentLaunch(f.workspace.id, worker.id, {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    })
  }
  const root = join(f.project, '.hive', 'workflows')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'quality.json'), JSON.stringify({ name: 'Quality', steps }))
  const call = (suffix: string, body?: unknown) =>
    fetch(`${f.server.baseUrl}/api/ui/workspaces/${f.workspace.id}/workflows${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: f.cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const response = await call('/runs', { workflow_id: 'quality.json' })
  expect(response.status).toBe(201)
  const started = (await response.json()) as { id: string }
  const run = () => f.server.store.workflows.get(f.workspace.id, started.id) as WorkflowRun
  for (let pass = 0; pass < steps.length; pass += 1) {
    for (const step of run().steps) {
      if (!step.dispatchId || step.status !== 'running') continue
      const dispatch = required(f.server.store.getDispatch(f.workspace.id, step.dispatchId))
      const accepted = await fetch(`${f.server.baseUrl}/api/team/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: f.workspace.id,
          from_agent_id: dispatch.toAgentId,
          token: f.server.store.peekAgentToken(dispatch.toAgentId),
          dispatch_id: dispatch.id,
          progress_state: 'accepted',
          result: 'Accepted for quality coverage',
        }),
      })
      expect(accepted.status).toBe(202)
    }
    await f.server.store.workflows.refresh(f.workspace.id, started.id)
  }
  const report = (id: string) => {
    const step = required(run().steps.find((item) => item.id === id))
    return f.server.store.reportTask(
      f.workspace.id,
      required(
        f.server.store
          .getWorkspaceSnapshot(f.workspace.id)
          .agents.find((a) => a.name === step.worker)
      ).id,
      {
        dispatchId: required(step.dispatchId),
        text: `Done ${id} attempt ${step.attempt}`,
        outcome: 'success',
      }
    )
  }
  return { f, call, run, report }
}

test('explicit all-of waits for current review AND verification, then dispatches once; report acceptance cannot bypass it', async () => {
  const { f, run, report } = await setup([
    {
      id: 'A',
      worker: 'Builder',
      task: 'Deliver code',
      quality: { all_of: ['report_success', 'review_accepted', 'verification_passed'] },
    },
    { id: 'B', worker: 'Downstream', task: 'Consume', needs: ['A'] },
  ])
  const dispatchId = required(run().steps[0]?.dispatchId)
  report('A')
  f.server.store.acceptDispatchReport(f.workspace.id, dispatchId, 1)
  await until(() => expect(run().steps[0]?.waitingFor).toContain('verification_passed'))
  expect(run().steps[1]?.dispatchId).toBeNull()
  const view = await f.server.store.verifications.view(f.workspace.id, dispatchId)
  await f.server.store.verifications.start(f.workspace.id, dispatchId, {
    command: 'node -e "console.log(42)"',
    headSha: required(view.headSha),
    reportRevision: view.reportRevision,
  })
  await until(async () =>
    expect(
      (await f.server.store.verifications.view(f.workspace.id, dispatchId)).runs[0]?.state
    ).toBe('passed')
  )
  expect(run().steps[1]?.dispatchId).toBeNull()
  const review = await f.server.store.codeReviews.view(f.workspace.id, dispatchId)
  const evidence = await f.server.store.codeReviews.submit(
    f.workspace.id,
    dispatchId,
    'local_user',
    {
      request_id: randomUUID(),
      version: required(review.version),
      conclusion: 'approve',
      summary: 'Reviewed this exact source and target',
    }
  )
  await f.server.store.codeReviews.accept(
    f.workspace.id,
    dispatchId,
    evidence.id,
    required(review.version)
  )
  await until(() => expect(run().steps[1]?.status, run().error ?? '').toBe('running'))
  const id = run().steps[1]?.dispatchId
  await f.server.store.codeReviews.accept(
    f.workspace.id,
    dispatchId,
    evidence.id,
    required(review.version)
  )
  await f.server.store.workflows.refresh(f.workspace.id, run().id)
  expect(run().steps[1]?.dispatchId).toBe(id)
  expect(run().steps[1]?.dependencyVersions?.A).toMatchObject({
    attempt: 1,
    dispatch_id: dispatchId,
    source_sha: f.source,
  })
  report('B')
  expect(run().status).toBe('completed')
  await writeFile(join(f.sourcePath, 'value.txt'), 'changed after completion\n')
  await commitReviewFixture(f.sourcePath, 'Invalidate dependency evidence')
  await f.server.store.workflows.refresh(f.workspace.id, run().id)
  expect(run().steps[0]?.status).toBe('awaiting_review')
  expect(run().steps[1]).toMatchObject({
    status: 'blocked',
    needsRerun: true,
    resultVersion: null,
    dispatchId: id,
  })
}, 90000)

test('manual report acceptance preserves legacy advancement and cannot satisfy explicit report_success', async () => {
  const { f, run } = await setup([
    { id: 'A', worker: 'Builder', task: 'Legacy task' },
    {
      id: 'B',
      worker: 'Downstream',
      task: 'Explicit report',
      needs: ['A'],
      quality: { all_of: ['report_success'] },
    },
  ])
  const dispatchA = required(run().steps[0]?.dispatchId)
  f.server.store.reportTask(f.workspace.id, f.worker.id, {
    dispatchId: dispatchA,
    text: 'Needs acceptance',
  })
  expect(run().steps[0]?.status).toBe('awaiting_review')
  f.server.store.acceptDispatchReport(f.workspace.id, dispatchA, 1)
  await until(() => expect(run().steps[1]?.dispatchId).toEqual(expect.any(String)))
  const dispatchB = required(run().steps[1]?.dispatchId)
  const worker = required(f.server.store.getDispatch(f.workspace.id, dispatchB)).toAgentId
  f.server.store.reportTask(f.workspace.id, worker, {
    dispatchId: dispatchB,
    text: 'Report without an explicit success outcome',
  })
  f.server.store.acceptDispatchReport(f.workspace.id, dispatchB, 1)
  await f.server.store.workflows.refresh(f.workspace.id, run().id)
  expect(run().steps[0]?.status).toBe('completed')
  expect(run().steps[1]).toMatchObject({
    status: 'awaiting_review',
    waitingFor: ['report_success'],
  })
  expect(run().status).toBe('running')
}, 90000)

test('rerun invalidates only A/B, waits for cancellation across restart and rejects old-attempt reports', async () => {
  const { f, call, run, report } = await setup([
    { id: 'A', worker: 'Builder', task: 'Prepare' },
    { id: 'B', worker: 'Downstream', task: 'Consume', needs: ['A'] },
    { id: 'C', worker: 'Independent', task: 'Independent work' },
  ])
  report('A')
  report('C')
  await until(() => expect(run().steps[1]?.status).toBe('running'))
  const oldB = required(run().steps[1]?.dispatchId)
  const c = required(run().steps[2])
  const response = await call(`/runs/${run().id}/steps/A/rerun`, {
    expected_attempt: 1,
    reason: 'Revise A',
  })
  expect(response.status).toBe(202)
  await until(() =>
    expect(f.server.store.getDispatch(f.workspace.id, oldB)?.status).toBe('cancelled')
  )
  expect(run().steps[0]?.attempt).toBe(1)
  expect(run().steps[0]?.rerunPending).toBe(true)
  await f.restart()
  f.server.store.workflows.resume(String(new URL(f.server.baseUrl).port))
  expect(run().steps[0]?.rerunPending).toBe(true)
  const bWorker = required(f.server.store.getDispatch(f.workspace.id, oldB)).toAgentId
  f.server.store.statusTask(f.workspace.id, bWorker, {
    dispatchId: oldB,
    progressState: 'cancelled',
  })
  await f.server.store.startAgent(f.workspace.id, bWorker, {
    hivePort: new URL(f.server.baseUrl).port,
  })
  await until(() =>
    expect(required(run().steps[0])).toMatchObject({ attempt: 2, status: 'running' })
  )
  expect(run().steps[2]).toEqual(c)
  report('A')
  await until(() =>
    expect(required(run().steps[1])).toMatchObject({ attempt: 2, dispatchId: expect.any(String) })
  )
  const newB = required(run().steps[1]?.dispatchId)
  expect(() =>
    f.server.store.reportTask(f.workspace.id, bWorker, {
      text: 'Ambiguous old attempt',
      outcome: 'success',
    })
  ).toThrow('dispatch_id')
  f.server.store.statusTask(f.workspace.id, bWorker, {
    dispatchId: newB,
    progressState: 'accepted',
  })
  expect(newB).not.toBe(oldB)
  const late = f.server.store.reportTask(f.workspace.id, bWorker, {
    dispatchId: oldB,
    text: 'Late result',
    outcome: 'success',
  })
  expect(late.lateReportId).toBeTruthy()
  expect(run().steps[1]?.status).toBe('running')
  report('B')
  expect(run().status).toBe('completed')
  expect(f.server.store.workflows.attempts(f.workspace.id, run().id)).toHaveLength(5)
  const history = await (await call(`/runs/${run().id}/attempts`)).json()
  expect(
    history.find(
      (entry: { step_id: string; attempt: number }) => entry.step_id === 'A' && entry.attempt === 1
    )
  ).toMatchObject({
    invalidated_at: expect.any(Number),
    snapshot: {
      dispatch_id: expect.any(String),
      input_version: expect.anything(),
      dependency_versions: {},
    },
  })
  expect(
    (await call(`/runs/${run().id}/steps/A/rerun`, { expected_attempt: 1, reason: 'Old page' }))
      .status
  ).toBe(409)
}, 90000)
