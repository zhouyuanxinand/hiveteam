// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TeamMemoryDreamPanel } from '../../web/src/knowledge/TeamMemoryDreamPanel.js'
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
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    headers.set('cookie', f.cookie)
    return fetchWithNodeSignal(new URL(path, f.server.baseUrl), { ...init, headers })
  })
  const open = () =>
    render(
      <TeamMemoryDreamPanel
        open
        dreamEnabled={false}
        onDreamEnabledChange={async () => {}}
        onMemoryChanged={() => {}}
        settingsBusy={false}
        workspaceId={f.workspace.id}
      />
    )
  return { ...f, open }
}

test('review UI removes only the selected proposal and submits unsaved edits with the exact preview, then rolls back', async () => {
  const f = await fixture()
  const source = f.server.store.memory.create(f.workspace.id, { kind: 'fact', body: 'Old fact' })
  const untouched = f.server.store.memory.create(f.workspace.id, {
    kind: 'decision',
    body: 'Keep this decision',
  })
  const run = f.server.store.memoryDream.create(f.workspace.id)
  f.open()
  const removed = (await screen.findByDisplayValue('Keep this decision')).closest('fieldset')
  if (!removed) throw new Error('Expected proposal fieldset')
  fireEvent.click(within(removed).getByRole('button', { name: /Remove proposal/ }))
  const body = screen.getByRole('textbox', { name: 'Result body' })
  fireEvent.change(body, { target: { value: 'Reviewed unsaved fact' } })
  expect(screen.getByRole('status')).toHaveTextContent(
    'Will change 1 existing memories and create 0.'
  )
  const preview = body.closest('fieldset')?.querySelector<HTMLElement>('.memory-dream-diff')
  if (!preview) throw new Error('Expected exact change preview')
  expect(within(preview).getByText('Old fact')).toBeVisible()
  expect(screen.getAllByText('Reviewed unsaved fact').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByTestId('memory-dream-submit'))
  expect(await screen.findByTestId('memory-dream-receipt')).toHaveTextContent(
    'Reviewed unsaved fact'
  )
  expect(f.server.store.memory.get(f.workspace.id, source.id)?.body).toBe('Reviewed unsaved fact')
  expect(f.server.store.memory.get(f.workspace.id, untouched.id)).toEqual(untouched)
  expect(
    f.server.store.memoryDream
      .get(f.workspace.id, run.id)
      ?.receipt?.changes.map((change) => change.memory_id)
  ).toEqual([source.id])
  fireEvent.click(screen.getByTestId('memory-dream-rollback'))
  await waitFor(() =>
    expect(f.server.store.memoryDream.get(f.workspace.id, run.id)?.status).toBe('rolled_back')
  )
  expect(await screen.findByText(/Existing memories were restored/)).toBeVisible()
  expect(f.server.store.memory.get(f.workspace.id, source.id)?.body).toBe('Old fact')
  expect(screen.queryByTestId('memory-dream-rollback')).toBeNull()
}, 30000)

test('a source conflict preserves the user edit and creating a new draft captures the changed source', async () => {
  const f = await fixture()
  const source = f.server.store.memory.create(f.workspace.id, {
    kind: 'fact',
    body: 'Original source',
  })
  const run = f.server.store.memoryDream.create(f.workspace.id)
  f.open()
  fireEvent.change(await screen.findByRole('textbox', { name: 'Result body' }), {
    target: { value: 'My reviewed result' },
  })
  f.server.store.memory.update(f.workspace.id, source.id, { body: 'Changed elsewhere' })
  fireEvent.click(screen.getByTestId('memory-dream-submit'))
  expect(await screen.findByRole('alert')).toHaveTextContent('changed since review')
  expect(screen.getByRole('textbox', { name: 'Result body' })).toHaveValue('My reviewed result')
  expect(f.server.store.memory.get(f.workspace.id, source.id)?.body).toBe('Changed elsewhere')
  expect(f.server.store.memoryDream.get(f.workspace.id, run.id)?.receipt).toBeNull()
  fireEvent.click(screen.getByTestId('memory-dream-new'))
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Result body' })).toHaveValue('Changed elsewhere')
  )
  expect(screen.queryByRole('alert')).toBeNull()
}, 30000)

test('legacy drafts expose readable history and regeneration, without apply or rollback controls', async () => {
  const f = await fixture()
  const run = f.server.store.memoryDream.create(f.workspace.id)
  f.db.prepare('UPDATE memory_dream_runs SET plan_version=0,suggestions_json=? WHERE id=?').run(
    JSON.stringify([
      {
        body: 'Historical suggestion',
        kind: 'fact',
        scope: 'workspace',
        sourceMemoryIds: [],
        tags: [],
        procedureRef: null,
      },
    ]),
    run.id
  )
  f.open()
  expect(await screen.findByText(/This legacy Dream is read-only/)).toBeVisible()
  expect(screen.getByText('Historical suggestion')).toBeVisible()
  expect(screen.queryByTestId('memory-dream-submit')).toBeNull()
  expect(screen.queryByTestId('memory-dream-save')).toBeNull()
  expect(screen.queryByTestId('memory-dream-rollback')).toBeNull()
  fireEvent.click(screen.getByTestId('memory-dream-new'))
  expect(await screen.findByRole('button', { name: 'Add proposal' })).toBeVisible()
  expect(screen.getByTestId('memory-dream-submit')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Add proposal' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Result body' }), {
    target: { value: 'New deliberate memory' },
  })
  fireEvent.click(screen.getByTestId('memory-dream-submit'))
  expect(await screen.findByTestId('memory-dream-receipt')).toHaveTextContent(
    'New deliberate memory'
  )
  expect(f.server.store.memory.list(f.workspace.id).map((entry) => entry.body)).toEqual([
    'New deliberate memory',
  ])
}, 30000)
