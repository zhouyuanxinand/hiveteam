// @vitest-environment jsdom
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { MemorySources } from '../../web/src/knowledge/MemorySources.js'
import { WorkspaceKnowledgeDrawer } from '../../web/src/knowledge/WorkspaceKnowledgeDrawer.js'
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
  const bridge = (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    headers.set('cookie', f.cookie)
    return fetchWithNodeSignal(new URL(path, f.server.baseUrl), { ...init, headers })
  }
  vi.stubGlobal('fetch', bridge)
  return { ...f, bridge }
}
const openSources = (element: HTMLElement) => {
  const details = element.closest('details')
  if (!details) throw new Error('Expected source details')
  details.open = true
  fireEvent(details, new Event('toggle'))
}

test('knowledge drawer captures a real report candidate, displays its evidence, and requires explicit approval before injection', async () => {
  const f = await fixture()
  const { dispatch } = await f.report('Cookie evidence')
  render(
    <WorkspaceKnowledgeDrawer
      open
      initialTab="memory"
      workspaceId={f.workspace.id}
      onClose={() => {}}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Add memory' }))
  fireEvent.change(screen.getByRole('textbox', { name: '' }), {
    target: { value: 'Keep cookie compatibility.' },
  })
  fireEvent.change(screen.getByLabelText('Source type'), { target: { value: 'dispatch' } })
  expect(screen.getByRole('button', { name: 'Save candidate' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Dispatch ID'), { target: { value: dispatch.id } })
  fireEvent.click(screen.getByRole('button', { name: 'Save candidate' }))
  expect(await screen.findByRole('button', { name: 'Approve' })).toBeVisible()
  expect(screen.getByRole('tab', { name: 'Candidates' })).toHaveAttribute('aria-selected', 'true')
  const candidate = f.server.store.memory.list(f.workspace.id, { status: 'candidate' })[0]
  expect(candidate?.body).toBe('Keep cookie compatibility.')
  expect(f.server.store.memory.listInjectable(f.workspace.id, 'cookie', 5)).toEqual([])
  openSources(screen.getByText('View sources'))
  expect(await screen.findByText('Completed: Cookie evidence')).toBeVisible()
  expect(screen.getByText(`Author at capture: ${f.worker.name} (coder)`)).toBeVisible()
  const receiptBefore = f.server.store.dispatchDelivery.records.list(f.workspace.id)
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull())
  fireEvent.click(screen.getByRole('tab', { name: 'Active' }))
  expect(await screen.findByText('Keep cookie compatibility.')).toBeVisible()
  expect(
    f.server.store.memory.listInjectable(f.workspace.id, 'cookie', 5).map((entry) => entry.id)
  ).toEqual([candidate?.id])
  expect(f.server.store.dispatchDelivery.records.list(f.workspace.id)).toEqual(receiptBefore)
}, 30000)

test('provenance loading retries a failed request and ignores a late response from the previous workspace', async () => {
  const f = await fixture()
  const { dispatch } = await f.report('Old workspace source')
  const entry = f.server.store.memory.create(f.workspace.id, {
    kind: 'fact',
    body: 'First memory',
    sourceRef: { type: 'dispatch', source_id: dispatch.id },
  })
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'other'), 'Other')
  const second = f.server.store.memory.create(other.id, {
    kind: 'fact',
    body: 'Second workspace manual source',
  })
  let fail = true
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (fail) {
      fail = false
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'Source temporarily unavailable' }), { status: 503 })
      )
    }
    return f.bridge(input, init)
  })
  const view = render(<MemorySources workspaceId={f.workspace.id} memoryId={entry.id} />)
  openSources(screen.getByText('View sources'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Source temporarily unavailable')
  let release: (() => void) | undefined
  let received = false
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await f.bridge(input, init)
    if (String(input).includes(entry.id)) {
      const body = await response.text()
      received = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return new Response(body, { status: response.status, headers: response.headers })
    }
    return response
  })
  fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(received).toBe(true))
  view.rerender(<MemorySources workspaceId={other.id} memoryId={second.id} />)
  expect(await screen.findByText('Second workspace manual source')).toBeVisible()
  await act(async () => release?.())
  expect(screen.queryByText('Completed: Old workspace source')).toBeNull()
  expect(screen.getByText('Source version unknown')).toBeVisible()
}, 30000)
