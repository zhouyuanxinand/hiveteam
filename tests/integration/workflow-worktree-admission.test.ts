import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createWorkflowEvidenceReader } from '../../src/server/workflow-evidence.js'
import type { WorkflowRun } from '../../src/shared/workflows.js'
import { createCodeReviewFixture } from '../helpers/code-review-fixture.js'

const gate = () => {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test('a worktree operation acquired during evidence reading defers downstream dispatch until release and dispatches once', async () => {
  const fixture = await createCodeReviewFixture()
  const evidenceRead = gate()
  const continueEvidence = gate()
  const releaseOperation = gate()
  let operation: Promise<void> | undefined
  try {
    const { server, workspace } = fixture
    const downstream = server.store.addWorker(workspace.id, { name: 'Downstream', role: 'coder' })
    server.store.configureAgentLaunch(workspace.id, downstream.id, {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    })
    const root = join(fixture.project, '.hive', 'workflows')
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'admission.json'),
      JSON.stringify({
        name: 'Worktree admission',
        steps: [
          { id: 'A', worker: 'Builder', task: 'Prepare', quality: { all_of: ['report_success'] } },
          { id: 'B', worker: 'Downstream', task: 'Consume', needs: ['A'] },
        ],
      })
    )
    const response = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/workflows/runs`,
      {
        method: 'POST',
        headers: { cookie: fixture.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ workflow_id: 'admission.json' }),
      }
    )
    expect(response.status).toBe(201)
    const started = (await response.json()) as { id: string }
    const run = () => server.store.workflows.get(workspace.id, started.id) as WorkflowRun
    const dispatchId = run().steps[0]?.dispatchId
    if (!dispatchId) throw new Error('Initial workflow dispatch was not created')
    const readEvidence = createWorkflowEvidenceReader(
      server.store.codeReviews,
      server.store.verifications
    )
    let held = false
    server.store.workflows.setEvidenceReader(async (...args) => {
      const evidence = await readEvidence(...args)
      if (!held && args[1].id === dispatchId && evidence.satisfied.includes('report_success')) {
        held = true
        evidenceRead.release()
        await continueEvidence.promise
      }
      return evidence
    })
    server.store.reportTask(workspace.id, fixture.worker.id, {
      dispatchId,
      outcome: 'success',
      text: 'Prepared',
    })
    await evidenceRead.promise
    operation = server.store.worktrees.exclusive(workspace.id, () => releaseOperation.promise)
    expect(server.store.worktrees.isBusy(workspace.id)).toBe(true)
    continueEvidence.release()
    await expect.poll(() => run().steps[0]?.status).toBe('completed')
    expect(run().status, run().error ?? '').toBe('running')
    expect(run().steps[1]).toMatchObject({ status: 'queued', dispatchId: null })
    expect(server.store.listAgentRuns(downstream.id)).toEqual([])

    releaseOperation.release()
    await operation
    await expect.poll(() => run().steps[1]?.status, { timeout: 8000 }).toBe('running')
    const firstDispatch = run().steps[1]?.dispatchId
    expect(firstDispatch).toEqual(expect.any(String))
    await server.store.workflows.refresh(workspace.id, started.id)
    expect(run().steps[1]?.dispatchId).toBe(firstDispatch)
    expect(server.store.listAgentRuns(downstream.id)).toHaveLength(1)
  } finally {
    continueEvidence.release()
    releaseOperation.release()
    await operation
    await fixture.close()
  }
}, 60_000)
