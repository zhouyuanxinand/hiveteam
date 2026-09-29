// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { runGit } from '../../src/server/git-command.js'
import { IntegrationCandidatePanel } from '../../web/src/activity/IntegrationCandidatePanel.js'
import { fromWorkflowRunPayload } from '../../web/src/api.js'
import { WorkflowRunSteps } from '../../web/src/knowledge/WorkflowRunSteps.js'
import { commitReviewFixture, createCodeReviewFixture } from '../helpers/code-review-fixture.js'

const nativeFetch = globalThis.fetch
const fixtures: Awaited<ReturnType<typeof createCodeReviewFixture>>[] = []
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__
  for (const f of fixtures.splice(0)) await f.close()
})
const setup = async () => {
  const f = await createCodeReviewFixture()
  fixtures.push(f)
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    headers.set('cookie', f.cookie)
    return nativeFetch(new URL(path, f.server.baseUrl), { ...init, headers })
  })
  return f
}
const until = (check: () => unknown | Promise<unknown>) =>
  waitFor(check, { timeout: 30000, interval: 100 })
const button = async (name: string) => {
  const element = await screen.findByRole('button', { name }, { timeout: 30000 })
  await until(() => expect(element).toBeEnabled())
  fireEvent.click(element)
}

test('quality workflow, local rerun, profile creation and reviewed candidate delivery cross the real HTTP, Git and SQLite boundaries', async () => {
  const f = await setup()
  const root = join(f.project, '.hive', 'workflows')
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'delivery.json'),
    JSON.stringify({
      name: 'Delivery',
      steps: [
        {
          id: 'code',
          worker: 'Builder',
          task: 'Deliver',
          quality: { all_of: ['report_success', 'review_accepted', 'verification_passed'] },
        },
      ],
    })
  )
  const workflow = await f.server.store.workflows.start(
    f.workspace.id,
    root,
    'delivery.json',
    new URL(f.server.baseUrl).port
  )
  const current = () => {
    const run = f.server.store.workflows.get(f.workspace.id, workflow.id)
    if (!run?.steps[0]?.dispatchId) throw new Error('Expected a dispatched workflow attempt')
    return { run, dispatchId: run.steps[0].dispatchId }
  }
  const complete = async () => {
    const { dispatchId } = current()
    f.server.store.reportTask(f.workspace.id, f.worker.id, {
      dispatchId,
      outcome: 'success',
      text: 'Delivered current attempt',
    })
    await until(() => expect(current().run.steps[0]?.waitingFor).toContain('verification_passed'))
    const version = await f.server.store.codeReviews.view(f.workspace.id, dispatchId)
    if (!version.version) throw new Error('Expected source version')
    const verification = await f.server.store.verifications.start(f.workspace.id, dispatchId, {
      headSha: version.version.source_sha,
      reportRevision: version.version.report_revision,
      command: 'node -e "console.log(\'verified\')"',
    })
    await until(() =>
      expect(f.server.store.verifications.get(verification.id)?.state).toBe('passed')
    )
    await until(async () =>
      expect((await f.server.store.verifications.view(f.workspace.id, dispatchId)).canAccept).toBe(
        true
      )
    )
    await f.server.store.verifications.accept(f.workspace.id, dispatchId, verification.id)
    const review = await f.server.store.codeReviews.submit(
      f.workspace.id,
      dispatchId,
      'local_user',
      {
        request_id: randomUUID(),
        version: version.version,
        conclusion: 'approve',
        summary: 'Inspected current attempt',
      }
    )
    await f.server.store.codeReviews.accept(f.workspace.id, dispatchId, review.id, version.version)
    await until(() => expect(current().run.status).toBe('completed'))
  }
  await complete()
  const oldDispatch = current().dispatchId
  const response = await fetch(`/api/ui/workspaces/${f.workspace.id}/workflows/runs/${workflow.id}`)
  const run = fromWorkflowRunPayload(await response.json())
  const workflowUi = render(<WorkflowRunSteps run={run} onChanged={() => {}} />)
  fireEvent.click(screen.getByText('Steps, quality conditions and reruns'))
  expect(screen.getByText('Completion conditions satisfied', { exact: false })).toBeVisible()
  await button('Rerun from this step')
  fireEvent.change(screen.getByLabelText('Rerun reason'), {
    target: { value: 'Revise the delivered value before integration' },
  })
  await button('Confirm rerun')
  await until(() => expect(current().run.steps[0]?.attempt).toBe(2))
  expect(current().dispatchId).not.toBe(oldDispatch)
  await writeFile(join(f.sourcePath, 'value.txt'), 'revised delivery\n')
  await commitReviewFixture(f.sourcePath, 'Revise delivery')
  await complete()
  workflowUi.unmount()
  for (const active of f.server.store.listAgentRuns(f.worker.id))
    if (active.status === 'running' || active.status === 'starting')
      f.server.store.stopAgentRun(active.runId)
  await until(() =>
    expect(
      f.server.store
        .listAgentRuns(f.worker.id)
        .every((run) => run.status === 'exited' || run.status === 'error')
    ).toBe(true)
  )
  await writeFile(join(f.project, 'independent.txt'), 'latest target\n')
  const target = await commitReviewFixture(f.project, 'Independent target contribution')

  const dispatchId = current().dispatchId
  render(
    <IntegrationCandidatePanel
      workspaceId={f.workspace.id}
      dispatchId={dispatchId}
      onChanged={() => {}}
    />
  )
  await button('Prepare candidate on current target')
  await screen.findByLabelText('Verification profile', {}, { timeout: 30000 })
  fireEvent.click(screen.getByText('Manage verification profiles'))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Combined delivery checks' } })
  fireEvent.change(screen.getByLabelText('Profile command'), {
    target: { value: 'node -e "console.log(\'COMBINED_OK token=example-secret\')"' },
  })
  fireEvent.click(
    screen.getByLabelText(
      'Allow preparation and verification to use host account permissions and network'
    )
  )
  await button('Save new profile')
  await button('Verify candidate')
  await screen.findByText('Candidate verification: passed', { exact: false }, { timeout: 30000 })
  expect(screen.getByRole('button', { name: 'Accept this candidate version' })).toBeDisabled()
  fireEvent.click(screen.getByText('Full log and diagnostics'))
  await button('Read tail')
  await screen.findByText('COMBINED_OK token=[REDACTED]', { exact: false }, { timeout: 30000 })
  fireEvent.change(screen.getByLabelText('Review of this candidate'), {
    target: { value: 'Reviewed both latest target and revised source' },
  })
  await button('Record approving candidate review')
  await button('Accept this candidate version')
  await button('Update local target branch')
  await screen.findByText('Integrated', { selector: 'strong' }, { timeout: 30000 })
  const candidate = f.server.store.candidates.list(f.workspace.id, dispatchId)[0]
  expect(candidate).toMatchObject({ state: 'integrated', target_sha: target })
  expect((await runGit(f.project, ['rev-parse', 'HEAD'])).trim()).toBe(candidate?.candidate_sha)
  expect(await readFile(join(f.project, 'value.txt'), 'utf8')).toBe('revised delivery\n')
  expect(await readFile(join(f.project, 'independent.txt'), 'utf8')).toBe('latest target\n')
  expect(f.server.store.workflows.attempts(f.workspace.id, workflow.id)).toHaveLength(2)
}, 180000)

test('remote candidate views omit local mutation controls', async () => {
  const f = await setup()
  ;(window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__ = true
  render(
    <IntegrationCandidatePanel
      workspaceId={f.workspace.id}
      dispatchId={f.dispatch.id}
      onChanged={() => {}}
    />
  )
  await screen.findByText(f.source, {}, { timeout: 30000 })
  expect(screen.queryByRole('button', { name: 'Prepare candidate on current target' })).toBeNull()
  expect(screen.queryByText('Manage verification profiles')).toBeNull()
  expect(f.server.store.candidates.list(f.workspace.id, f.dispatch.id)).toEqual([])
}, 60000)
