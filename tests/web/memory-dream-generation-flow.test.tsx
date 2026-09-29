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
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
const panel = (workspaceId: string) => (
  <TeamMemoryDreamPanel
    open
    dreamEnabled={false}
    onDreamEnabledChange={async () => {}}
    onMemoryChanged={() => {}}
    settingsBusy={false}
    workspaceId={workspaceId}
  />
)
const fixture = async (afterResponse?: (path: string, response: Response) => Promise<void>) => {
  const f = await createAttentionFixture()
  fixtures.push(f)
  let reads = 0
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    headers.set('cookie', f.cookie)
    const response = await fetchWithNodeSignal(new URL(path, f.server.baseUrl), {
      ...init,
      headers,
    })
    if (path.includes('/memory/dream/') && !init?.method) reads++
    await afterResponse?.(path, response)
    return response
  })
  return { ...f, open: () => render(panel(f.workspace.id)), reads: () => reads }
}
const recordInput = (f: Awaited<ReturnType<typeof fixture>>, text: string) =>
  createMessageLogStore(f.db).insertMessage({
    workspaceId: f.workspace.id,
    workerId: f.actor,
    type: 'user_input',
    text,
    createdAt: Date.now(),
  })

const currentRun = (f: Awaited<ReturnType<typeof fixture>>) => {
  const run = f.server.store.memoryDream.list(f.workspace.id).find((item) => item.generation)
  if (!run?.generation) throw new Error('Expected a persisted generation batch')
  return run
}
const claim = (f: Awaited<ReturnType<typeof fixture>>, run: TeamMemoryDreamRun) => {
  const runId = randomUUID()
  f.server.store.memoryDreamGeneration.claim(f.workspace.id, run.id, runId)
  const requested = f.server.store.memoryDream.get(f.workspace.id, run.id)
  if (!requested?.generation?.attempt_id) throw new Error('Expected a claimed generation attempt')
  return { runId, generation: requested.generation }
}
const complete = (
  f: Awaited<ReturnType<typeof fixture>>,
  run: TeamMemoryDreamRun,
  body: string
) => {
  const { runId, generation } = claim(f, run)
  const sequence = generation.input.messages[0]?.sequence
  if (!sequence || !generation.attempt_id) throw new Error('Expected frozen evidence')
  f.server.store.memoryDreamGeneration.complete(
    f.workspace.id,
    run.id,
    runId,
    generation.attempt_id,
    generation.input_hash,
    {
      candidates: [
        {
          body,
          kind: 'decision',
          scope: 'workspace',
          procedure_ref: null,
          tags: ['release'],
          source_sequences: [sequence],
        },
      ],
      summary: 'Keep the release channel decision.',
    }
  )
  return sequence
}

test('an empty generation explains that no model was requested and leaves existing memories unchanged', async () => {
  const f = await fixture()
  const source = f.server.store.memory.create(f.workspace.id, {
    kind: 'fact',
    body: 'Keep existing memory',
  })
  f.open()
  await waitFor(() => expect(screen.getByTestId('memory-dream-generate')).toBeEnabled())
  fireEvent.click(screen.getByTestId('memory-dream-generate'))
  expect(
    await screen.findByText('No new eligible messages. No model generation was requested.')
  ).toBeVisible()
  expect(f.server.store.memoryDream.list(f.workspace.id)).toEqual([])
  expect(f.server.store.memory.get(f.workspace.id, source.id)).toEqual(source)
  expect(screen.queryByTestId('memory-dream-submit')).toBeNull()
}, 30000)

test('the real generation flow freezes partial evidence, polls completion, and requires explicit apply with unsaved edits', async () => {
  const f = await fixture()
  const body = `Use stable releases. ${'evidence '.repeat(1600)}`
  recordInput(f, body)
  f.open()
  await waitFor(() => expect(screen.getByTestId('memory-dream-generate')).toBeEnabled())
  fireEvent.click(screen.getByTestId('memory-dream-generate'))
  expect(await screen.findByText('Waiting for the workspace Orchestrator')).toBeVisible()
  expect(screen.queryByTestId('memory-dream-submit')).toBeNull()
  expect(screen.queryByTestId('memory-dream-discard')).toBeNull()
  expect(screen.queryByRole('textbox', { name: 'Result body' })).toBeNull()
  fireEvent.click(screen.getByText(/View frozen message batch/))
  expect(screen.getByText(/Character range 1–12000/)).toHaveTextContent('(message excerpt)')
  const run = currentRun(f)
  const sequence = complete(f, run, 'Use stable releases for production.')
  expect(
    await screen.findByRole('textbox', { name: 'Result body' }, { timeout: 6000 })
  ).toHaveValue('Use stable releases for production.')
  expect(f.server.store.memory.list(f.workspace.id)).toEqual([])
  expect(screen.getByText(`Messages cited by this proposal: #${sequence}`)).toBeVisible()
  const sourceDetails = screen.getByText(`Messages cited by this proposal: #${sequence}`)
  fireEvent.click(sourceDetails)
  const sourceGroup = sourceDetails.closest('details')
  if (!sourceGroup) throw new Error('Expected proposal evidence details')
  expect(within(sourceGroup).getByText(body.slice(0, 12000).trim())).toBeVisible()
  fireEvent.change(screen.getByRole('textbox', { name: 'Result body' }), {
    target: { value: 'Use stable releases only after review.' },
  })
  fireEvent.click(screen.getByTestId('memory-dream-submit'))
  expect(await screen.findByTestId('memory-dream-receipt')).toHaveTextContent(
    'Use stable releases only after review.'
  )
  expect(f.server.store.memory.list(f.workspace.id).map((entry) => entry.body)).toEqual([
    'Use stable releases only after review.',
  ])
  const receipt = screen.getByTestId('memory-dream-receipt')
  fireEvent.click(within(receipt).getByText(`Messages cited by this proposal: #${sequence}`))
  expect(within(receipt).getByText(body.slice(0, 12000).trim())).toBeVisible()
  expect(
    f.server.store.memoryDream.get(f.workspace.id, run.id)?.operations[0]?.message_sources
  ).toEqual([sequence])
}, 30000)

test('failed generation can retry the same frozen batch and completed candidates can be discarded without changing memory', async () => {
  const f = await fixture()
  const source = f.server.store.memory.create(f.workspace.id, {
    kind: 'fact',
    body: 'Unchanged fact',
  })
  f.server.store.configureAgentLaunch(f.workspace.id, f.actor, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  await f.server.store.startAgent(f.workspace.id, f.actor, {
    hivePort: new URL(f.server.baseUrl).port,
  })
  recordInput(f, 'Use stable releases.')
  const run = f.server.store.memoryDreamGeneration.prepare(f.workspace.id)
  if (!run) throw new Error('Expected message batch')
  const { generation } = claim(f, run)
  if (!generation.attempt_id) throw new Error('Expected attempt')
  f.server.store.memoryDreamGeneration.fail(
    f.workspace.id,
    run.id,
    generation.attempt_id,
    'Provider temporarily unavailable'
  )
  f.open()
  expect(await screen.findByRole('alert')).toHaveTextContent('Provider temporarily unavailable')
  expect(screen.queryByTestId('memory-dream-submit')).toBeNull()
  fireEvent.click(screen.getByTestId('memory-dream-retry'))
  expect(await screen.findByText('Orchestrator is generating candidates')).toBeVisible()
  const retried = currentRun(f)
  expect(retried.id).toBe(run.id)
  expect(retried.generation?.input_hash).toBe(generation.input_hash)
  complete(f, retried, 'Use stable releases for production.')
  expect(await screen.findByTestId('memory-dream-discard', {}, { timeout: 6000 })).toBeEnabled()
  fireEvent.click(screen.getByTestId('memory-dream-discard'))
  expect(await screen.findByText(/This batch was discarded/)).toBeVisible()
  expect(f.server.store.memoryDream.get(f.workspace.id, run.id)?.status).toBe('discarded')
  expect(f.server.store.memory.get(f.workspace.id, source.id)).toEqual(source)
  expect(screen.queryByTestId('memory-dream-submit')).toBeNull()
  fireEvent.click(screen.getByTestId('memory-dream-generate'))
  expect(
    await screen.findByText('No new eligible messages. No model generation was requested.')
  ).toBeVisible()
}, 30000)

test('polling a pending batch preserves a different draft edit and a late generation response cannot cross workspaces', async () => {
  let releaseResponse: (() => void) | undefined
  let delayed = false
  let enteredGate: (() => void) | undefined
  const reachedGate = new Promise<void>((resolve) => {
    enteredGate = resolve
  })
  const gate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  const f = await fixture(async (path) => {
    if (delayed && path.endsWith('/memory/dream/generate')) {
      enteredGate?.()
      await gate
    }
  })
  f.server.store.memory.create(f.workspace.id, { kind: 'fact', body: 'Original fact' })
  recordInput(f, 'Message for first workspace')
  f.server.store.memoryDreamGeneration.prepare(f.workspace.id)
  const draft = f.server.store.memoryDream.create(f.workspace.id)
  const view = f.open()
  const history = await screen.findByTestId('memory-dream-history')
  fireEvent.change(history, { target: { value: draft.id } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Result body' }), {
    target: { value: 'Keep my unsaved edit' },
  })
  const initialReads = f.reads()
  await waitFor(() => expect(f.reads()).toBeGreaterThan(initialReads), { timeout: 6000 })
  expect(screen.getByRole('textbox', { name: 'Result body' })).toHaveValue('Keep my unsaved edit')
  fireEvent.change(history, { target: { value: currentRun(f).id } })
  expect(screen.getByText('Waiting for the workspace Orchestrator')).toBeVisible()
  fireEvent.change(history, { target: { value: draft.id } })
  expect(screen.getByRole('textbox', { name: 'Result body' })).toHaveValue('Keep my unsaved edit')
  delayed = true
  fireEvent.click(screen.getByTestId('memory-dream-generate'))
  await reachedGate
  const other = f.server.store.createWorkspace(f.server.dataDir, 'Other workspace')
  view.rerender(panel(other.id))
  expect(await screen.findByText(/No Dream reviews yet/)).toBeVisible()
  await act(async () => {
    releaseResponse?.()
    await gate
  })
  await waitFor(() => expect(screen.getByTestId('memory-dream-generate')).toBeEnabled())
  expect(screen.queryByText('Waiting for the workspace Orchestrator')).toBeNull()
  expect(screen.queryByText('Keep my unsaved edit')).toBeNull()
  expect(screen.queryByTestId('memory-dream-history')).toBeNull()
}, 30000)

test('an existing review explains its generation block, and a zero-candidate batch closes without applying memory', async () => {
  const f = await fixture()
  const source = f.server.store.memory.create(f.workspace.id, {
    kind: 'fact',
    body: 'Preserve this fact',
  })
  f.server.store.memoryDream.create(f.workspace.id)
  recordInput(f, 'Thanks for the update.')
  f.open()
  await screen.findByTestId('memory-dream-discard')
  fireEvent.click(screen.getByTestId('memory-dream-generate'))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Apply or discard the existing Dream draft'
  )
  expect(
    screen.queryByText('No new eligible messages. No model generation was requested.')
  ).toBeNull()
  fireEvent.click(screen.getByTestId('memory-dream-discard'))
  expect(await screen.findByText(/This batch was discarded/)).toBeVisible()
  fireEvent.click(screen.getByTestId('memory-dream-generate'))
  expect(await screen.findByText('Waiting for the workspace Orchestrator')).toBeVisible()
  const run = currentRun(f)
  const { runId, generation } = claim(f, run)
  if (!generation.attempt_id) throw new Error('Expected attempt')
  f.server.store.memoryDreamGeneration.complete(
    f.workspace.id,
    run.id,
    runId,
    generation.attempt_id,
    generation.input_hash,
    {
      candidates: [],
      summary: 'The message acknowledges earlier work but contains no reusable fact.',
    }
  )
  expect(
    await screen.findByText(
      'This batch produced no candidates and is closed. Existing memories are unchanged.',
      {},
      { timeout: 6000 }
    )
  ).toBeVisible()
  expect(f.server.store.memoryDream.get(f.workspace.id, run.id)?.status).toBe('discarded')
  expect(f.server.store.memory.get(f.workspace.id, source.id)).toEqual(source)
  expect(screen.queryByTestId('memory-dream-submit')).toBeNull()
}, 30000)
