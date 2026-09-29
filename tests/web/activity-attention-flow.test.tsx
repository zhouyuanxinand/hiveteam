// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ActivityCenterDrawer } from '../../web/src/activity/ActivityCenterDrawer.js'
import { AttentionPanel } from '../../web/src/activity/AttentionPanel.js'
import { createAttentionFixture } from '../helpers/attention-fixture.js'

import { fetchWithNodeSignal } from '../helpers/fetch-with-node-signal.js'

const fixtures: Awaited<ReturnType<typeof createAttentionFixture>>[] = []
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  for (const f of fixtures.splice(0)) await f.close()
})
const fixture = async () => {
  const f = await createAttentionFixture()
  fixtures.push(f)
  const fetchThroughServer = (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    headers.set('cookie', f.cookie)
    return fetchWithNodeSignal(new URL(path, f.server.baseUrl), { ...init, headers })
  }
  vi.stubGlobal('fetch', fetchThroughServer)
  return { ...f, fetchThroughServer }
}

test('activity attention opens and accepts the actual report, then locates its independent receipt', async () => {
  const f = await fixture(),
    first = await f.report('API acceptance'),
    second = await f.report('Another report')
  render(<ActivityCenterDrawer open workspaceId={f.workspace.id} onClose={() => {}} />)
  const drawer = await screen.findByTestId('activity-center-drawer')
  // Keep the existing activity view as the initial surface.
  expect(within(drawer).getByRole('button', { name: 'Needs attention' })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  fireEvent.click(within(drawer).getByRole('button', { name: 'Needs attention' }))
  const panel = await screen.findByRole('region', { name: 'Needs attention' })
  await within(panel).findByRole('option', { name: 'All (4)' })
  fireEvent.change(within(panel).getByLabelText('Item type'), { target: { value: 'acceptance' } })
  const task = await within(panel).findByText('API acceptance')
  const row = task.closest('li')
  if (!row) throw new Error('Missing attention row')
  fireEvent.click(within(row).getByRole('button', { name: 'Inspect report' }))
  expect(await within(row).findByRole('button', { name: 'Accept this report' })).toBeVisible()
  fireEvent.click(within(row).getByRole('button', { name: 'Accept this report' }))
  await waitFor(() => expect(within(panel).queryByText('API acceptance')).toBeNull())
  expect(f.server.store.getDispatch(f.workspace.id, first.dispatch.id)?.acceptedAt).toEqual(
    expect.any(Number)
  )
  expect(f.server.store.dispatchDelivery.records.get(first.receipt.id)?.state).toBe('pending')
  fireEvent.change(within(panel).getByLabelText('Item type'), {
    target: { value: 'report_delivery' },
  })
  const receiptTask = await within(panel).findByText('API acceptance')
  const receiptRow = receiptTask.closest('li')
  if (!receiptRow) throw new Error('Missing report receipt row')
  fireEvent.click(within(receiptRow).getByRole('button', { name: 'Inspect delivery receipt' }))
  const deliveries = await screen.findByRole('region', { name: 'Task delivery and health' })
  expect(await within(deliveries).findByText('API acceptance')).toBeVisible()
  expect(within(deliveries).queryByText('Another report')).toBeNull()
  expect(f.server.store.dispatchDelivery.records.get(first.receipt.id)?.attempt).toBe(0)
  fireEvent.click(within(deliveries).getByRole('button', { name: 'Show all deliveries' }))
  expect(await within(deliveries).findByText('Another report')).toBeVisible()
  expect(f.server.store.dispatchDelivery.records.get(second.receipt.id)?.state).toBe('pending')
}, 30000)

test('attention pagination and filters retain counts beyond the first page', async () => {
  const f = await fixture()
  const insert = f.db.prepare(
    'INSERT INTO dispatches(id,workspace_id,to_agent_id,text,status,created_at) VALUES(?,?,?,?,?,?)'
  )
  f.db.transaction(() => {
    for (let i = 1; i <= 51; i++)
      insert.run(randomUUID(), f.workspace.id, f.worker.id, `Waiting task ${i}`, 'queued', i)
  })()
  render(<AttentionPanel workspaceId={f.workspace.id} onInspectDelivery={() => {}} />)
  await screen.findByText('Waiting task 1')
  expect(screen.queryByText('Waiting task 26')).toBeNull()
  expect(screen.getByRole('option', { name: 'All (51)' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByText('Waiting task 26')
  expect(screen.queryByText('Waiting task 1')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
  expect(await screen.findByText('Waiting task 1')).toBeVisible()
  fireEvent.change(screen.getByLabelText('Item type'), { target: { value: 'question' } })
  expect(await screen.findByText('No items need attention in this view.')).toBeVisible()
  expect(screen.getByRole('option', { name: 'All (51)' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
}, 30000)

test('failed loads can be retried and a late response cannot replace the selected workspace', async () => {
  const f = await fixture()
  await f.task('First workspace task')
  let fail = true
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/attention') && fail) {
      fail = false
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'Attention unavailable' }), { status: 503 })
      )
    }
    return f.fetchThroughServer(input, init)
  })
  const view = render(<AttentionPanel workspaceId={f.workspace.id} onInspectDelivery={() => {}} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Attention unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh attention' }))
  expect(await screen.findByText('First workspace task')).toBeVisible()
  let release: (() => void) | undefined
  let received = false
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await f.fetchThroughServer(input, init)
    if (String(input).includes(`${f.workspace.id}/attention`)) {
      const body = await response.text()
      received = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return new Response(body, { status: response.status, headers: response.headers })
    }
    return response
  })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh attention' }))
  await waitFor(() => expect(received).toBe(true))
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'second'), 'Second')
  const worker = f.server.store.addWorker(other.id, { name: 'Second coder', role: 'coder' })
  await f.server.store.dispatchTask(other.id, worker.id, 'Second workspace task')
  view.rerender(<AttentionPanel workspaceId={other.id} onInspectDelivery={() => {}} />)
  expect(await screen.findByText('Second workspace task')).toBeVisible()
  await act(async () => release?.())
  expect(screen.getByText('Second workspace task')).toBeVisible()
  expect(screen.queryByText('First workspace task')).toBeNull()
}, 30000)

test('a new report revision closes the old expanded report and requires inspecting the new version', async () => {
  const f = await fixture(),
    { dispatch } = await f.report('Versioned result')
  f.server.store.configureAgentLaunch(f.workspace.id, f.worker.id, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  const started = await f.request(
    `/api/workspaces/${f.workspace.id}/agents/${f.worker.id}/start`,
    {}
  )
  expect(started.status, await started.clone().text()).toBe(201)

  render(<AttentionPanel workspaceId={f.workspace.id} onInspectDelivery={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect report' }))
  await screen.findByRole('button', { name: 'Accept this report' })
  const feedback = await f.request(
    `/api/ui/workspaces/${f.workspace.id}/dispatches/${dispatch.id}/feedback`,
    { text: 'Revise the result' }
  )
  expect(feedback.status, await feedback.clone().text()).toBe(202)
  f.server.store.reportTask(f.workspace.id, f.worker.id, {
    dispatchId: dispatch.id,
    text: 'Replacement report after rework',
    outcome: 'success',
    requireActiveRun: true,
  })
  await screen.findByText('Replacement report after rework', {}, { timeout: 10000 })
  expect(screen.queryByRole('button', { name: 'Accept this report' })).toBeNull()
  expect(screen.queryByText('Completed: Versioned result')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect report' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Accept this report' }))
  await waitFor(() =>
    expect(f.server.store.getDispatch(f.workspace.id, dispatch.id)).toMatchObject({
      reportRevision: 2,
      acceptedAt: expect.any(Number),
    })
  )
}, 30000)
