// @vitest-environment jsdom
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ActivityCenterDrawer } from '../../web/src/activity/ActivityCenterDrawer.js'
import { CollaborationStatsPanel } from '../../web/src/activity/CollaborationStatsPanel.js'
import { createAttentionFixture } from '../helpers/attention-fixture.js'
import { seedCollaborationStats } from '../helpers/collaboration-stats-fixture.js'
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
  const bridge = (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    headers.set('cookie', f.cookie)
    return fetchWithNodeSignal(new URL(path, f.server.baseUrl), { ...init, headers })
  }
  vi.stubGlobal('fetch', bridge)
  return { ...f, bridge }
}

test('activity statistics displays real root totals, sample coverage and missing data; filtering and refresh do not resend', async () => {
  const f = await fixture(),
    ids = seedCollaborationStats(f)
  f.db
    .prepare('UPDATE dispatches SET created_at=? WHERE id=?')
    .run(Date.now() - 40 * 86_400_000, ids.queued)
  const before = f.server.store.dispatchDelivery.records.list(f.workspace.id)
  render(<ActivityCenterDrawer open workspaceId={f.workspace.id} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Statistics' }))
  const panel = await screen.findByRole('region', { name: 'Collaboration statistics' })
  expect(await within(panel).findByText('9 B')).toBeVisible()
  expect(within(panel).getByRole('row', { name: 'Queue 225 ms 150 ms 300 ms 2 / 0' })).toBeVisible()
  fireEvent.change(within(panel).getByLabelText('Task creation period'), {
    target: { value: 'all' },
  })
  expect(
    await within(panel).findByRole('row', { name: 'Queue 225 ms 150 ms 300 ms 2 / 1' })
  ).toBeVisible()
  f.db.prepare('DELETE FROM delivery_payload_measurements').run()
  fireEvent.click(within(panel).getByRole('button', { name: 'Refresh statistics' }))
  expect(await within(panel).findByText('Not measured yet')).toBeVisible()
  expect(
    within(panel).getByText('0 measured attempts · 8 unmeasured · 1 deliveries awaiting an attempt')
  ).toBeVisible()
  expect(f.server.store.dispatchDelivery.records.list(f.workspace.id)).toEqual(before)
  fireEvent.click(screen.getByRole('button', { name: 'Needs attention' }))
  expect(await screen.findByRole('region', { name: 'Needs attention' })).toBeVisible()
}, 30000)

test('failed statistics loads retry, and stale responses cannot replace another workspace', async () => {
  const f = await fixture()
  seedCollaborationStats(f)
  let fail = true
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (fail && String(input).includes('/collaboration-stats')) {
      fail = false
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'Statistics unavailable' }), { status: 503 })
      )
    }
    return f.bridge(input, init)
  })
  const view = render(<CollaborationStatsPanel workspaceId={f.workspace.id} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Statistics unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh statistics' }))
  await screen.findByText('9 B')
  let release: (() => void) | undefined
  let received = false
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await f.bridge(input, init)
    if (String(input).includes(`${f.workspace.id}/collaboration-stats`)) {
      const body = await response.text()
      received = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return new Response(body, { status: response.status, headers: response.headers })
    }
    return response
  })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh statistics' }))
  await waitFor(() => expect(received).toBe(true))
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'another'), 'Another')
  view.rerender(<CollaborationStatsPanel workspaceId={other.id} />)
  expect(await screen.findByText('No retained tasks were created in this period.')).toBeVisible()
  await act(async () => release?.())
  expect(screen.queryByText('9 B')).toBeNull()
  expect(screen.getByText('Not measured yet')).toBeVisible()
}, 30000)
