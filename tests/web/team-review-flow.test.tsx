// @vitest-environment jsdom
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TeamReviewRequests } from '../../web/src/activity/TeamReviewRequests.js'
import { commitReviewFixture } from '../helpers/code-review-fixture.js'
import { createTeamReviewFixture } from '../helpers/team-review-fixture.js'

const nativeFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('review history reads real reports, retirement, stale versions and retained worktree resources', async () => {
  const f = await createTeamReviewFixture()
  try {
    const review = await f.create()
    if (!review.working_directory || !review.review_dispatch_id)
      throw new Error('Review not prepared')
    await writeFile(join(review.working_directory, 'inspection.txt'), 'retained inspection notes')
    const response = await f.post(
      '/api/team/report',
      {
        dispatch_id: review.review_dispatch_id,
        result: 'Pinned API behavior verified',
        outcome: 'success',
      },
      review.reviewer_id
    )
    expect(response.status, await response.clone().text()).toBe(202)
    await expect
      .poll(() => f.server.store.getWorker(f.workspace.id, review.reviewer_id).retiredAt, {
        timeout: 12000,
      })
      .toEqual(expect.any(Number))
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('cookie', f.cookie)
      return nativeFetch(new URL(path, f.server.baseUrl), { ...init, headers })
    })
    render(
      <TeamReviewRequests
        workspaceId={f.workspace.id}
        dispatchId={f.dispatch.id}
        refreshKey="initial"
      />
    )
    fireEvent.click(screen.getByText('Temporary reviewer tasks'))
    expect(
      await screen.findByText('Pinned API behavior verified', {}, { timeout: 15000 })
    ).toBeVisible()
    expect(screen.getByText(/Retired; evidence retained/)).toBeVisible()
    fireEvent.click(screen.getByText('Task and retained directory'))
    expect(screen.getByText(review.working_directory)).toBeVisible()
    expect(screen.getByText(/checkout has changes/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect worktree resources' }))
    expect(await screen.findByRole('region', { name: 'Retained worktree resources' })).toBeVisible()
    await writeFile(join(f.sourcePath, 'value.txt'), 'next version\n')
    await commitReviewFixture(f.sourcePath, 'Advance reviewed source')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh review tasks' }))
    expect(
      await screen.findByText(
        'Historical findings are stale: Source commit changed',
        {},
        { timeout: 15000 }
      )
    ).toBeVisible()
    expect(screen.getByText('Pinned API behavior verified')).toBeVisible()
    expect(f.server.store.getDispatch(f.workspace.id, f.dispatch.id)?.acceptedAt).toBeNull()
  } finally {
    cleanup()
    vi.unstubAllGlobals()
    await f.close()
  }
}, 90000)
