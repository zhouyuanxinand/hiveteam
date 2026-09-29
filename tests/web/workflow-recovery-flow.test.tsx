// @vitest-environment jsdom
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { I18nProvider } from '../../web/src/i18n.js'
import { WorkspaceKnowledgeDrawer } from '../../web/src/knowledge/WorkspaceKnowledgeDrawer.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'
import { createCodeReviewFixture } from '../helpers/code-review-fixture.js'
import { fetchWithNodeSignal } from '../helpers/fetch-with-node-signal.js'

const fixtures: Awaited<ReturnType<typeof createCodeReviewFixture>>[] = []
afterEach(async () => {
  cleanup()
  window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
  vi.unstubAllGlobals()
  delete (window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
const setup = async () => {
  const f = await createCodeReviewFixture(false)
  fixtures.push(f)
  const folder = join(f.project, '.hive', 'workflows')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'recovery-ui.json'),
    JSON.stringify({
      name: 'Delivery recovery',
      steps: [{ id: 'A', worker: 'Builder', task: 'Wait for the reviewed receipt' }],
    })
  )
  const started = await f.server.store.workflows.start(
    f.workspace.id,
    folder,
    'recovery-ui.json',
    new URL(f.server.baseUrl).port
  )
  const id = started.steps[0]?.dispatchId
  if (!id) throw new Error('Expected workflow dispatch')
  await expect.poll(() => f.server.store.dispatchDelivery.records.get(id)?.state).toBe('unknown')
  await f.server.store.workflows.refresh(f.workspace.id, started.id)
  expect(f.server.store.workflows.get(f.workspace.id, started.id)?.status).toBe('interrupted')
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    headers.set('cookie', f.cookie)
    return fetchWithNodeSignal(new URL(path, f.server.baseUrl), { ...init, headers })
  })
  return { f, started, id }
}
const panel = (workspaceId: string) => (
  <WorkspaceKnowledgeDrawer
    initialTab="workflows"
    open
    workspaceId={workspaceId}
    onClose={() => {}}
  />
)

test('interrupted workflow exposes original delivery review and keeps polling after manual handling', async () => {
  const { f, started, id } = await setup()
  render(panel(f.workspace.id))
  expect(await screen.findByText('Interrupted')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Review delivery for step A' }))
  const delivery = await screen.findByRole('region', { name: 'Task delivery and health' })
  expect(await within(delivery).findByText('Receipt unconfirmed')).toBeVisible()
  fireEvent.click(within(delivery).getByRole('button', { name: 'Review manually' }))
  fireEvent.change(within(delivery).getByRole('textbox', { name: 'Reason' }), {
    target: { value: 'Reviewed the original terminal and confirmed safe continuation' },
  })
  // Both workflow and receipt poll every two seconds; a refresh must preserve the review draft.
  await new Promise((resolve) => setTimeout(resolve, 2200))
  expect(within(delivery).getByRole('textbox', { name: 'Reason' })).toHaveValue(
    'Reviewed the original terminal and confirmed safe continuation'
  )
  fireEvent.click(
    within(delivery).getByRole('checkbox', {
      name: 'I checked receipt and the composer is safe to continue this recipient’s queue.',
    })
  )
  fireEvent.click(within(delivery).getByRole('button', { name: 'Mark handled' }))
  await waitFor(() =>
    expect(f.server.store.dispatchDelivery.records.get(id)?.state).toBe('resolved')
  )
  await waitFor(() => expect(screen.getByText('Running', { exact: true })).toBeVisible(), {
    timeout: 7000,
  })
  expect(screen.queryByText('Interrupted')).toBeNull()
  expect(f.server.store.workflows.get(f.workspace.id, started.id)?.steps[0]?.dispatchId).toBe(id)
  expect(f.server.store.getDispatch(f.workspace.id, id)?.status).toBe('submitted')
}, 30000)

test('stopping an interrupted run prevents delivery resolution from reviving it', async () => {
  const { f, started, id } = await setup()
  render(panel(f.workspace.id))
  expect(await screen.findByText('Interrupted')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(await screen.findByText('Stopped', { exact: true })).toBeVisible()
  expect(f.server.store.getDispatch(f.workspace.id, id)?.status).toBe('cancelled')
  const resolved = await fetch(
    `/api/ui/workspaces/${f.workspace.id}/message-deliveries/${id}/resolve`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'handled',
        reason: 'Original terminal reviewed after stopping',
        composer_safe: true,
      }),
    }
  )
  expect(resolved.status).toBe(200)
  expect(f.server.store.dispatchDelivery.records.get(id)?.state).toBe('resolved')
  await f.server.store.workflows.refresh(f.workspace.id, started.id)
  expect(f.server.store.workflows.get(f.workspace.id, started.id)?.status).toBe('stopped')
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
}, 30000)

test('Chinese remote view explains the interruption without exposing local recovery actions', async () => {
  const { f } = await setup()
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'zh')
  ;(window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__ = true
  render(<I18nProvider>{panel(f.workspace.id)}</I18nProvider>)
  expect(await screen.findByText('已中断', { exact: true })).toBeVisible()
  expect(screen.getByText('后续步骤已暂停')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '查看步骤 A 的投递' }))
  const delivery = await screen.findByRole('region', { name: '任务投递与健康' })
  expect(await within(delivery).findByText('接收未确认')).toBeVisible()
  expect(within(delivery).getByText('远程可查看；投递处理与超时设置需在本机操作。')).toBeVisible()
  expect(within(delivery).queryByRole('button', { name: '人工处理' })).toBeNull()
  expect(within(delivery).queryByRole('textbox')).toBeNull()
}, 30000)

test('focused cancellation recovery requires execution-stop confirmation before advancing the workflow attempt', async () => {
  const { f, started, id } = await setup()
  const run = () => f.server.store.workflows.get(f.workspace.id, started.id)
  render(panel(f.workspace.id))
  expect(await screen.findByText('Interrupted')).toBeVisible()
  const accepted = await fetchWithNodeSignal(`${f.server.baseUrl}/api/team/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: f.workspace.id,
      from_agent_id: f.worker.id,
      token: f.server.store.peekAgentToken(f.worker.id),
      dispatch_id: id,
      progress_state: 'accepted',
      result: 'Accepted the original workflow responsibility',
    }),
  })
  expect(accepted.status).toBe(202)
  await f.server.store.workflows.refresh(f.workspace.id, started.id)
  await waitFor(() => expect(screen.getByText('Running', { exact: true })).toBeVisible(), {
    timeout: 7000,
  })
  const rerun = await fetch(
    `/api/ui/workspaces/${f.workspace.id}/workflows/runs/${started.id}/steps/A/rerun`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_attempt: 1, reason: 'Revised workflow execution' }),
    }
  )
  expect(rerun.status).toBe(202)
  const cancellation = () =>
    f.server.store.dispatchDelivery.records
      .list(f.workspace.id)
      .find((record) => record.dispatch_id === id && record.kind === 'cancel')
  await expect.poll(() => cancellation()?.state, { timeout: 7000 }).toBe('unknown')
  await f.server.store.workflows.refresh(f.workspace.id, started.id)
  await waitFor(
    () =>
      expect(screen.getByText(/The original task has not been confirmed stopped/)).toBeVisible(),
    { timeout: 7000 }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Review delivery for step A' }))
  const delivery = await screen.findByRole('region', { name: 'Task delivery and health' })
  const cancellationId = cancellation()?.id
  if (!cancellationId) throw new Error('Expected persisted cancellation receipt')
  expect(await within(delivery).findByText(`Delivery receipt: ${cancellationId}`)).toBeVisible()
  const review = await within(delivery).findByText('Review cancellation')
  expect(review).toBeVisible()
  expect(within(delivery).getAllByRole('listitem')).toHaveLength(1)

  fireEvent.click(within(delivery).getByRole('button', { name: 'Review manually' }))
  fireEvent.change(within(delivery).getByRole('textbox', { name: 'Reason' }), {
    target: { value: 'The cancellation message reached the original terminal' },
  })
  fireEvent.click(
    within(delivery).getByRole('checkbox', {
      name: 'I checked receipt and the composer is safe to continue this recipient’s queue.',
    })
  )
  fireEvent.click(within(delivery).getByRole('button', { name: 'Mark handled' }))
  await waitFor(() => expect(cancellation()?.state).toBe('resolved'))
  await f.server.store.workflows.refresh(f.workspace.id, started.id)
  expect(run()?.steps[0]).toMatchObject({ attempt: 1, dispatchId: id, rerunPending: true })
  expect(f.server.store.dispatchDelivery.health.get(id)?.cancellation_confirmed_at).toBeNull()

  fireEvent.click(review)
  const confirm = within(delivery).getByRole('button', { name: 'Record stop confirmation' })
  expect(confirm).toBeDisabled()
  fireEvent.change(within(delivery).getByRole('textbox', { name: 'Evidence' }), {
    target: { value: 'Checked the original terminal and verified this task stopped executing' },
  })
  fireEvent.click(
    within(delivery).getByRole('checkbox', {
      name: 'I verified that this task stopped executing.',
    })
  )
  fireEvent.click(confirm)
  await waitFor(() =>
    expect(f.server.store.dispatchDelivery.health.get(id)?.cancellation_confirmed_at).toEqual(
      expect.any(Number)
    )
  )
  await f.server.store.workflows.refresh(f.workspace.id, started.id)
  await expect.poll(() => run()?.steps[0]?.attempt, { timeout: 7000 }).toBe(2)
  await expect
    .poll(() => run()?.steps[0]?.dispatchId, { timeout: 7000 })
    .toEqual(expect.any(String))
  expect(run()?.steps[0]?.dispatchId).not.toBe(id)
  expect(f.server.store.getDispatch(f.workspace.id, id)?.status).toBe('cancelled')
  expect(f.server.store.workflows.attempts(f.workspace.id, started.id)).toHaveLength(2)
}, 30000)
