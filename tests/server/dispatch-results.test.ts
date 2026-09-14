import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const directories: string[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const setup = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-dispatch-results-'))
  directories.push(dataDir)
  const server = await startTestServer({ dataDir })
  servers.push(server)
  const root = join(dataDir, 'workspace')
  const workflowRoot = join(root, '.hive', 'workflows')
  mkdirSync(workflowRoot, { recursive: true })
  writeFileSync(
    join(workflowRoot, 'change.json'),
    JSON.stringify({
      name: 'Change',
      steps: [
        { id: 'implement', worker: 'Builder', task: 'Implement the change.' },
        { id: 'review', worker: 'Reviewer', task: 'Review the change.', needs: ['implement'] },
      ],
    })
  )
  const workspace = server.store.createWorkspace(root, 'Results')
  const builder = server.store.addWorker(workspace.id, { name: 'Builder', role: 'coder' })
  const reviewer = server.store.addWorker(workspace.id, { name: 'Reviewer', role: 'reviewer' })
  for (const worker of [builder, reviewer])
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    })
  const cookie = await getUiCookie(server.baseUrl)
  const post = (path: string, body: unknown, authenticated = true) =>
    fetch(`${server.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
      body: JSON.stringify(body),
    })
  const runResponse = await post(`/api/ui/workspaces/${workspace.id}/workflows/runs`, {
    workflow_id: 'change.json',
  })
  expect(runResponse.status).toBe(201)
  const run = (await runResponse.json()) as { id: string; steps: Array<{ dispatch_id: string }> }
  const dispatchId = run.steps[0]?.dispatch_id
  if (!dispatchId) throw new Error('Expected implementation dispatch')
  const dispatchPath = `/api/ui/workspaces/${workspace.id}/dispatches/${dispatchId}`
  const report = (outcome?: unknown) =>
    post('/api/team/report', {
      project_id: workspace.id,
      from_agent_id: builder.id,
      token: server.store.peekAgentToken(builder.id),
      dispatch_id: dispatchId,
      result: 'Result text is preserved verbatim, independent of the declared outcome.',
      artifacts: ['checks.txt'],
      ...(outcome !== undefined ? { outcome } : {}),
    })
  return {
    server,
    dataDir,
    workspace,
    builder,
    reviewer,
    cookie,
    post,
    run,
    dispatchId,
    dispatchPath,
    report,
  }
}

describe('dispatch results and acceptance', () => {
  test.each([
    'failed',
    'blocked',
    'partial',
  ])('%s reports preserve the report and block dependent work', async (outcome) => {
    const ctx = await setup()
    expect((await ctx.report(outcome)).status).toBe(202)
    const dispatch = ctx.server.store.getDispatch(ctx.workspace.id, ctx.dispatchId)
    expect(dispatch).toMatchObject({
      status: 'reported',
      reportOutcome: outcome,
      reportRevision: 1,
      acceptedAt: null,
      artifacts: ['checks.txt'],
    })
    expect(ctx.server.store.workflows.get(ctx.workspace.id, ctx.run.id)?.steps).toEqual([
      expect.objectContaining({ status: 'blocked', dispatchId: ctx.dispatchId }),
      expect.objectContaining({ status: 'queued', dispatchId: null }),
    ])
    expect(
      ctx.server.store.listWorkers(ctx.workspace.id).find((worker) => worker.id === ctx.builder.id)
    ).toMatchObject({ pendingTaskCount: 0, status: 'idle' })
    expect((await ctx.post(`${ctx.dispatchPath}/accept`, { report_revision: 1 })).status).toBe(409)

    expect(
      (
        await ctx.post(`${ctx.dispatchPath}/feedback`, {
          text: 'Resolve the blocker and report again.',
        })
      ).status
    ).toBe(202)
    expect(ctx.server.store.getDispatch(ctx.workspace.id, ctx.dispatchId)).toMatchObject({
      status: 'submitted',
      reportOutcome: null,
      acceptedAt: null,
    })
    expect((await ctx.report('success')).status).toBe(202)
    await vi.waitFor(() =>
      expect(ctx.server.store.workflows.get(ctx.workspace.id, ctx.run.id)?.steps[1]).toMatchObject({
        status: 'running',
        dispatchId: expect.any(String),
      })
    )
  })

  test('legacy reports wait for acceptance; acceptance is authenticated, revision-bound, and durable', async () => {
    const ctx = await setup()
    expect((await ctx.report()).status).toBe(202)
    expect(ctx.server.store.workflows.get(ctx.workspace.id, ctx.run.id)?.steps[0]?.status).toBe(
      'awaiting_review'
    )
    expect(
      (await ctx.post(`${ctx.dispatchPath}/accept`, { report_revision: 1 }, false)).status
    ).toBe(403)
    expect((await ctx.post(`${ctx.dispatchPath}/accept`, { report_revision: 0 })).status).toBe(400)
    expect((await ctx.post(`${ctx.dispatchPath}/accept`, { report_revision: 2 })).status).toBe(409)
    const response = await ctx.post(`${ctx.dispatchPath}/accept`, { report_revision: 1 })
    expect(response.status).toBe(200)
    const accepted = await response.json()
    expect(accepted).toMatchObject({
      report_outcome: null,
      report_revision: 1,
      accepted_at: expect.any(Number),
      state: 'reported',
    })
    await vi.waitFor(() =>
      expect(ctx.server.store.workflows.get(ctx.workspace.id, ctx.run.id)?.steps[1]?.status).toBe(
        'running'
      )
    )
    const duplicate = await ctx.post(`${ctx.dispatchPath}/accept`, { report_revision: 1 })
    expect((await duplicate.json()).accepted_at).toBe(accepted.accepted_at)
    await servers.pop()?.close()
    const restarted = await startTestServer({ dataDir: ctx.dataDir })
    servers.push(restarted)
    expect(restarted.store.getDispatch(ctx.workspace.id, ctx.dispatchId)).toMatchObject({
      acceptedAt: accepted.accepted_at,
      reportRevision: 1,
      reportOutcome: null,
    })
  })

  test('success advances execution without accepting the report; feedback invalidates acceptance and dependent results', async () => {
    const ctx = await setup()
    expect((await ctx.report('success')).status).toBe(202)
    await vi.waitFor(() =>
      expect(ctx.server.store.workflows.get(ctx.workspace.id, ctx.run.id)?.steps[1]?.status).toBe(
        'running'
      )
    )
    expect(ctx.server.store.getDispatch(ctx.workspace.id, ctx.dispatchId)?.acceptedAt).toBeNull()
    expect((await ctx.post(`${ctx.dispatchPath}/accept`, { report_revision: 1 })).status).toBe(200)
    expect(
      (await ctx.post(`${ctx.dispatchPath}/feedback`, { text: 'Please address this regression.' }))
        .status
    ).toBe(202)
    expect(ctx.server.store.getDispatch(ctx.workspace.id, ctx.dispatchId)).toMatchObject({
      acceptedAt: null,
      reportOutcome: null,
      reportRevision: 1,
      status: 'submitted',
    })
    expect(ctx.server.store.workflows.get(ctx.workspace.id, ctx.run.id)?.status).toBe('failed')
    await vi.waitFor(() =>
      expect(
        ctx.server.store
          .listWorkers(ctx.workspace.id)
          .find((worker) => worker.id === ctx.reviewer.id)?.pendingTaskCount
      ).toBe(0)
    )
    expect((await ctx.report('success')).status).toBe(202)
    expect((await ctx.post(`${ctx.dispatchPath}/accept`, { report_revision: 1 })).status).toBe(409)
    const accepted = await ctx.post(`${ctx.dispatchPath}/accept`, { report_revision: 2 })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      report_revision: 2,
      accepted_at: expect.any(Number),
    })
  })

  test('invalid outcomes leave the dispatch and pending work unchanged', async () => {
    const ctx = await setup()
    expect((await ctx.report('verified')).status).toBe(400)
    expect(ctx.server.store.getDispatch(ctx.workspace.id, ctx.dispatchId)).toMatchObject({
      status: 'submitted',
      reportOutcome: null,
      reportRevision: 0,
      reportText: null,
    })
    expect(
      ctx.server.store.listWorkers(ctx.workspace.id).find((worker) => worker.id === ctx.builder.id)
        ?.pendingTaskCount
    ).toBe(1)
  })
})
