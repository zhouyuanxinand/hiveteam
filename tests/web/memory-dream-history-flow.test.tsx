// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createMessageLogStore } from '../../src/server/message-log-store.js'
import type { TeamMemoryDreamRun } from '../../src/shared/team-memory.js'
import { TeamMemoryDreamPanel } from '../../web/src/knowledge/TeamMemoryDreamPanel.js'
import { createAttentionFixture } from '../helpers/attention-fixture.js'
import { fetchWithNodeSignal } from '../helpers/fetch-with-node-signal.js'

const fixtures: Awaited<ReturnType<typeof createAttentionFixture>>[] = []
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  for (const f of fixtures.splice(0)) await f.close()
})
const panel = (workspaceId: string, open = true) => (
  <TeamMemoryDreamPanel
    open={open}
    dreamEnabled={false}
    onDreamEnabledChange={async () => {}}
    onMemoryChanged={() => {}}
    settingsBusy={false}
    workspaceId={workspaceId}
  />
)
const fixture = async (afterResponse?: (path: string) => Promise<void>) => {
  const f = await createAttentionFixture()
  fixtures.push(f)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    headers.set('cookie', f.cookie)
    const response = await fetchWithNodeSignal(new URL(path, f.server.baseUrl), {
      ...init,
      headers,
    })
    await afterResponse?.(path)
    return response
  })
  return f
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const insertMessage = (f: Fixture, text: string) =>
  createMessageLogStore(f.db).insertMessage({
    workspaceId: f.workspace.id,
    workerId: f.actor,
    type: 'user_input',
    text,
    createdAt: Date.now(),
  })
const earlier = (f: Fixture, run: TeamMemoryDreamRun, timestamp = 1) =>
  f.db.prepare('UPDATE memory_dream_runs SET created_at=? WHERE id=?').run(timestamp, run.id)
const addHistory = (f: Fixture, count = 22) => {
  for (let i = 0; i < count; i++) {
    const run = f.server.store.memoryDream.create(f.workspace.id)
    f.server.store.memoryDream.discard(f.workspace.id, run.id, run.planRevision)
  }
}
const selectRun = (id: string) =>
  fireEvent.change(screen.getByTestId('memory-dream-history'), { target: { value: id } })
const waitIdle = () =>
  waitFor(() => expect(screen.getByTestId('memory-dream-generate')).toBeEnabled())
const loadEarlier = async (id: string) => {
  fireEvent.click(screen.getByTestId('memory-dream-history-more'))
  await waitFor(() =>
    expect(
      screen.getByTestId('memory-dream-history').querySelector(`option[value="${id}"]`)
    ).not.toBeNull()
  )
  await waitIdle()
}
const complete = (f: Fixture, run: TeamMemoryDreamRun) => {
  const runId = randomUUID()
  const claimed = f.server.store.memoryDreamGeneration.claim(f.workspace.id, run.id, runId)
  const generation = claimed?.generation
  if (!generation?.attempt_id) throw new Error('Expected a generation attempt')
  return f.server.store.memoryDreamGeneration.complete(
    f.workspace.id,
    run.id,
    runId,
    generation.attempt_id,
    generation.input_hash,
    {
      candidates: [
        {
          body: 'Recovered sourced decision',
          kind: 'decision',
          scope: 'workspace',
          procedure_ref: null,
          tags: [],
          source_sequences: [generation.input.messages[0]?.sequence],
        },
      ],
      summary: 'Recovered the failed batch.',
    }
  )
}

test('an older blocking draft is reachable through Needs review and can be discarded before new generation', async () => {
  const f = await fixture()
  f.server.store.memory.create(f.workspace.id, { kind: 'fact', body: 'Older review content' })
  const old = f.server.store.memoryDream.create(f.workspace.id)
  earlier(f, old)
  addHistory(f)
  insertMessage(f, 'A new durable decision.')
  render(panel(f.workspace.id))
  await waitIdle()
  expect(screen.getByTestId('memory-dream-review-count')).toHaveTextContent('1')
  expect(screen.queryByRole('textbox', { name: 'Result body' })).toBeNull()
  fireEvent.click(screen.getByTestId('memory-dream-generate'))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Apply or discard the existing Dream draft'
  )
  await waitIdle()
  fireEvent.click(screen.getByTestId('memory-dream-history-review'))
  expect(await screen.findByRole('textbox', { name: 'Result body' })).toHaveValue(
    'Older review content'
  )
  await waitIdle()
  fireEvent.click(screen.getByTestId('memory-dream-discard'))
  await waitFor(() =>
    expect(screen.getByTestId('memory-dream-review-count')).toHaveTextContent('0')
  )
  expect(f.server.store.memoryDream.get(f.workspace.id, old.id)?.status).toBe('discarded')
  await waitIdle()
  fireEvent.click(screen.getByTestId('memory-dream-generate'))
  expect(await screen.findByText('Waiting for the workspace Orchestrator')).toBeVisible()
  await waitFor(() =>
    expect(screen.getByTestId('memory-dream-review-count')).toHaveTextContent('1')
  )
}, 30000)

test('earlier receipts remain reachable and can roll back without clearing newer history', async () => {
  const f = await fixture()
  const source = f.server.store.memory.create(f.workspace.id, {
    kind: 'fact',
    body: 'Before receipt',
  })
  const draft = f.server.store.memoryDream.create(f.workspace.id)
  const operations = draft.operations.map((operation) => ({
    ...operation,
    result: operation.result && { ...operation.result, body: 'Applied historical result' },
  }))
  f.server.store.memoryDream.submit(
    f.workspace.id,
    draft.id,
    { id: f.actor, name: 'Orchestrator' },
    draft.planRevision,
    operations
  )
  earlier(f, draft)
  addHistory(f)
  render(panel(f.workspace.id))
  await waitIdle()
  expect(screen.queryByTestId('memory-dream-receipt')).toBeNull()
  await loadEarlier(draft.id)
  selectRun(draft.id)
  expect(screen.getByTestId('memory-dream-receipt')).toHaveTextContent('Applied historical result')
  fireEvent.click(screen.getByTestId('memory-dream-rollback'))
  await waitFor(() =>
    expect(screen.getByTestId('memory-dream-receipt')).toHaveTextContent(
      'Existing memories were restored'
    )
  )
  expect(f.server.store.memory.get(f.workspace.id, source.id)?.body).toBe('Before receipt')
  await waitIdle()
  expect(within(screen.getByTestId('memory-dream-history')).getAllByRole('option')).toHaveLength(23)
  fireEvent.click(screen.getByTestId('memory-dream-history-review'))
  await waitIdle()
  expect(screen.getByTestId('memory-dream-receipt')).toHaveTextContent('Applied historical result')
  fireEvent.click(screen.getByTestId('memory-dream-history-all'))
  await waitIdle()
  expect(within(screen.getByTestId('memory-dream-history')).getAllByRole('option')).toHaveLength(23)
}, 30000)

test('a failed batch recovers in the background while loaded history and edits survive filtering and polling', async () => {
  let refreshed = false
  const f = await fixture(async (path) => {
    if (path.includes('/memory/dream/') && !path.includes('/history')) refreshed = true
  })
  f.server.store.memory.create(f.workspace.id, { kind: 'fact', body: 'Editable original' })
  insertMessage(f, 'Reusable decision evidence')
  const run = f.server.store.memoryDreamGeneration.prepare(f.workspace.id)
  if (!run) throw new Error('Expected generation')
  const claimed = f.server.store.memoryDreamGeneration.claim(f.workspace.id, run.id, randomUUID())
  if (!claimed?.generation?.attempt_id) throw new Error('Expected attempt')
  f.server.store.memoryDreamGeneration.fail(
    f.workspace.id,
    run.id,
    claimed.generation.attempt_id,
    'Temporary model outage'
  )
  earlier(f, run)
  const draft = f.server.store.memoryDream.create(f.workspace.id)
  earlier(f, draft, 2)
  addHistory(f)
  render(panel(f.workspace.id))
  await waitIdle()
  await loadEarlier(run.id)
  selectRun(run.id)
  expect(screen.getByRole('alert')).toHaveTextContent('Temporary model outage')
  selectRun(draft.id)
  fireEvent.change(screen.getByRole('textbox', { name: 'Result body' }), {
    target: { value: 'Keep this unsaved edit' },
  })
  fireEvent.click(screen.getByTestId('memory-dream-history-review'))
  await waitIdle()
  expect(screen.getByRole('textbox', { name: 'Result body' })).toHaveValue('Keep this unsaved edit')
  fireEvent.click(screen.getByTestId('memory-dream-history-all'))
  await waitIdle()
  complete(f, run)
  await waitFor(() => expect(refreshed).toBe(true), { timeout: 6000 })
  selectRun(run.id)
  expect(
    await screen.findByRole('textbox', { name: 'Result body' }, { timeout: 6000 })
  ).toHaveValue('Recovered sourced decision')
  selectRun(draft.id)
  expect(screen.getByRole('textbox', { name: 'Result body' })).toHaveValue('Keep this unsaved edit')
  expect(within(screen.getByTestId('memory-dream-history')).getAllByRole('option')).toHaveLength(24)
}, 30000)

test('late history pages cannot populate another workspace or a reopened drawer', async () => {
  let release: (() => void) | undefined
  let reached: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    reached = resolve
  })
  const f = await fixture(async (path) => {
    if (path.includes('/memory/dream/history?') && path.includes('cursor=')) {
      reached?.()
      await gate
    }
  })
  addHistory(f, 23)
  const view = render(panel(f.workspace.id))
  await waitIdle()
  fireEvent.click(screen.getByTestId('memory-dream-history-more'))
  await entered
  const other = f.server.store.createWorkspace(f.server.dataDir, 'Other history workspace')
  view.rerender(panel(other.id))
  await waitIdle()
  expect(await screen.findByText(/No Dream reviews yet/)).toBeVisible()
  await act(async () => {
    release?.()
    await gate
  })
  expect(screen.queryByTestId('memory-dream-history')).toBeNull()
  expect(screen.queryByTestId('memory-dream-history-more')).toBeNull()
  view.rerender(panel(f.workspace.id, false))
  expect(screen.queryByTestId('memory-dream-panel')).toBeNull()
  view.rerender(panel(other.id))
  await waitIdle()
  expect(screen.queryByTestId('memory-dream-history')).toBeNull()
}, 30000)

test('closing and reopening the drawer ignores a page returned from the earlier opening', async () => {
  let release: (() => void) | undefined
  let reached: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    reached = resolve
  })
  const f = await fixture(async (path) => {
    if (path.includes('/memory/dream/history?') && path.includes('cursor=')) {
      reached?.()
      await gate
    }
  })
  addHistory(f, 23)
  const view = render(panel(f.workspace.id))
  await waitIdle()
  fireEvent.click(screen.getByTestId('memory-dream-history-more'))
  await entered
  view.rerender(panel(f.workspace.id, false))
  expect(screen.queryByTestId('memory-dream-panel')).toBeNull()
  view.rerender(panel(f.workspace.id))
  await waitIdle()
  expect(within(screen.getByTestId('memory-dream-history')).getAllByRole('option')).toHaveLength(20)
  await act(async () => {
    release?.()
    await gate
  })
  expect(within(screen.getByTestId('memory-dream-history')).getAllByRole('option')).toHaveLength(20)
  expect(screen.getByTestId('memory-dream-history-more')).toBeEnabled()
}, 30000)

test('a history refresh publishes a completed current generation before its next poll', async () => {
  const f = await fixture()
  insertMessage(f, 'Evidence for the recovered current candidate')
  const run = f.server.store.memoryDreamGeneration.prepare(f.workspace.id)
  if (!run) throw new Error('Expected generation')
  const claimed = f.server.store.memoryDreamGeneration.claim(f.workspace.id, run.id, randomUUID())
  if (!claimed?.generation?.attempt_id) throw new Error('Expected attempt')
  f.server.store.memoryDreamGeneration.fail(
    f.workspace.id,
    run.id,
    claimed.generation.attempt_id,
    'Temporary current failure'
  )
  render(panel(f.workspace.id))
  await waitIdle()
  expect(screen.getByRole('alert')).toHaveTextContent('Temporary current failure')
  complete(f, run)
  fireEvent.click(screen.getByTestId('memory-dream-history-all'))
  await waitIdle()
  expect(screen.getByRole('textbox', { name: 'Result body' })).toHaveValue(
    'Recovered sourced decision'
  )
  expect(screen.queryByTestId('memory-dream-retry')).toBeNull()
}, 30000)

test('a review refresh removes externally closed drafts and refreshes the selected record without erasing dirty edits', async () => {
  const f = await fixture()
  f.server.store.memory.create(f.workspace.id, { kind: 'fact', body: 'Shared draft source' })
  const closed = f.server.store.memoryDream.create(f.workspace.id)
  const editable = f.server.store.memoryDream.create(f.workspace.id)
  render(panel(f.workspace.id))
  await waitIdle()
  selectRun(editable.id)
  fireEvent.change(screen.getByRole('textbox', { name: 'Result body' }), {
    target: { value: 'Unsaved draft result' },
  })
  const replacement = editable.operations.map((operation) => ({
    ...operation,
    result: operation.result && {
      ...operation.result,
      body: 'Another reviewer saved this version',
    },
  }))
  f.server.store.memoryDream.updateOperations(
    f.workspace.id,
    editable.id,
    editable.planRevision,
    replacement
  )
  selectRun(closed.id)
  f.server.store.memoryDream.discard(f.workspace.id, closed.id, closed.planRevision)
  fireEvent.click(screen.getByTestId('memory-dream-history-review'))
  await waitIdle()
  expect(screen.getByTestId('memory-dream-review-count')).toHaveTextContent('1')
  expect(screen.queryByRole('textbox', { name: 'Result body' })).toBeNull()
  expect(screen.getByText(/This batch was discarded/)).toBeVisible()
  selectRun(editable.id)
  expect(screen.queryByTestId('memory-dream-history')).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Result body' })).toHaveValue('Unsaved draft result')
  fireEvent.click(screen.getByTestId('memory-dream-submit'))
  expect(await screen.findByRole('alert')).toHaveTextContent('The Dream draft changed')
  expect(screen.getByRole('textbox', { name: 'Result body' })).toHaveValue('Unsaved draft result')
}, 30000)
