// @vitest-environment jsdom
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { CodeReviewPanel } from '../../web/src/activity/CodeReviewPanel.js'
import { commitReviewFixture, createCodeReviewFixture } from '../helpers/code-review-fixture.js'

const nativeFetch = globalThis.fetch
const fixtures: Awaited<ReturnType<typeof createCodeReviewFixture>>[] = []
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__
  for (const fixture of fixtures.splice(0)) await fixture.close()
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

test('desktop reviews are separate from report acceptance and an old page cannot accept a newer source', async () => {
  const f = await setup()
  render(
    <CodeReviewPanel workspaceId={f.workspace.id} dispatchId={f.dispatch.id} onChanged={() => {}} />
  )
  const record = await screen.findByRole('button', { name: 'Record review' }, { timeout: 15000 })
  expect(record).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Desktop review conclusion'), {
    target: { value: 'approve' },
  })
  fireEvent.change(screen.getByLabelText('Review notes'), {
    target: { value: 'Checked the exact source diff.' },
  })
  fireEvent.click(record)
  const accept = await screen.findByRole(
    'button',
    { name: 'Accept review for this version' },
    { timeout: 15000 }
  )
  await waitFor(() => expect(accept).toBeEnabled(), { timeout: 15000 })
  expect((await f.server.store.codeReviews.view(f.workspace.id, f.dispatch.id)).accepted).toBe(
    false
  )
  fireEvent.change(screen.getByLabelText('Review notes'), {
    target: { value: 'Draft notes must survive a stale version error.' },
  })
  await writeFile(join(f.sourcePath, 'value.txt'), 'new source\n')
  await commitReviewFixture(f.sourcePath, 'Advance after page load')
  fireEvent.click(accept)
  expect(await screen.findByRole('alert', {}, { timeout: 15000 })).toHaveTextContent(
    'Code, baseline, repository or report changed'
  )
  expect(screen.getByLabelText('Review notes')).toHaveValue(
    'Draft notes must survive a stale version error.'
  )
  expect((await f.server.store.codeReviews.view(f.workspace.id, f.dispatch.id)).accepted).toBe(
    false
  )
  fireEvent.click(screen.getByRole('button', { name: 'Refresh version' }))
  await screen.findByText('Source commit changed', {}, { timeout: 15000 })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Record review' })).toBeEnabled(), {
    timeout: 15000,
  })
  expect(screen.queryByRole('button', { name: 'Accept review for this version' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Desktop review conclusion'), {
    target: { value: 'approve' },
  })
  fireEvent.change(screen.getByLabelText('Review notes'), {
    target: { value: 'Re-reviewed the new commit.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Record review' }))
  const current = await screen.findByRole(
    'button',
    { name: 'Accept review for this version' },
    { timeout: 15000 }
  )
  await waitFor(() => expect(current).toBeEnabled(), { timeout: 15000 })
  fireEvent.click(current)
  await screen.findByText('Review accepted for the current version', {}, { timeout: 15000 })
  expect(f.server.store.getDispatch(f.workspace.id, f.dispatch.id)?.acceptedAt).toBeNull()
  expect(
    (await f.server.store.codeReviews.view(f.workspace.id, f.dispatch.id)).reviews
  ).toHaveLength(2)
}, 60_000)

test('remote review view exposes evidence without desktop write controls', async () => {
  const f = await setup()
  const context = await f.server.store.codeReviews.context(f.workspace.id, f.dispatch.id)
  if (!context.version) throw new Error('Expected Git version')
  await f.server.store.codeReviews.submit(f.workspace.id, f.dispatch.id, 'local_user', {
    request_id: crypto.randomUUID(),
    version: context.version,
    conclusion: 'approve',
    summary: 'Ready for desktop acceptance.',
  })
  ;(window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__ = true
  render(
    <CodeReviewPanel workspaceId={f.workspace.id} dispatchId={f.dispatch.id} onChanged={() => {}} />
  )
  await screen.findByText('Ready for desktop acceptance.', {}, { timeout: 15000 })
  expect(
    screen.getByText('Remote access is read-only. Record or accept reviews on the desktop.')
  ).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Accept review for this version' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Record review' })).toBeNull()
  expect((await f.server.store.codeReviews.view(f.workspace.id, f.dispatch.id)).accepted).toBe(
    false
  )
}, 60_000)
