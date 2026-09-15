// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DispatchPullRequestPanel } from '../../web/src/activity/DispatchPullRequestPanel.js'
import * as api from '../../web/src/activity/pull-request-api.js'
import type { DispatchSummary } from '../../web/src/api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'

const dispatch: DispatchSummary = {
  id: 'dispatch',
  workspaceId: 'workspace',
  toAgentId: 'worker',
  fromAgentId: null,
  text: 'Deliver change',
  reportText: 'Verified change',
  artifacts: [],
  state: 'reported',
  reportOutcome: 'success',
  reportRevision: 1,
  acceptedAt: 3,
  baseHeadSha: 'b'.repeat(40),
  createdAt: 1,
  submittedAt: 2,
  deliveredAt: 2,
  reportedAt: 3,
}
const preview = (): api.PullRequestView => ({
  repository: 'example/delivery',
  branch: 'hive/worker-example',
  base_branch: 'main',
  head_sha: 'a'.repeat(40),
  verification_id: 'verification',
  can_publish: true,
  reason: null,
  publication: null,
})
beforeEach(() => window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en'))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})
const show = () =>
  render(
    <I18nProvider>
      <DispatchPullRequestPanel dispatch={dispatch} onChanged={() => {}} />
    </I18nProvider>
  )

test('shows an initial request error without leaving a false loading message', async () => {
  vi.spyOn(api, 'requestPullRequest').mockRejectedValue(
    new Error('Finish the Git operation before publishing.')
  )
  show()
  expect(await screen.findByRole('alert')).toHaveTextContent('Finish the Git operation')
  expect(screen.queryByText('Loading dispatches…')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Refresh pull request and CI' })).toBeEnabled()
})

test('previews the destination and displays a PR only when the server confirms publication', async () => {
  let finish: ((view: api.PullRequestView) => void) | undefined
  vi.spyOn(api, 'requestPullRequest').mockImplementation(async (_workspace, _dispatch, action) =>
    action
      ? new Promise((resolve) => {
          finish = resolve
        })
      : preview()
  )
  show()
  expect(await screen.findByText('example/delivery')).toBeVisible()
  expect(screen.getByLabelText('PR title')).toHaveValue('Deliver change')
  fireEvent.click(screen.getByRole('button', { name: 'Push and create draft PR' }))
  expect(screen.getByRole('button', { name: 'Publishing…' })).toBeDisabled()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  finish?.({
    ...preview(),
    can_publish: false,
    reason: 'published',
    publication: {
      head_sha: 'a'.repeat(40),
      verification_id: 'verification',
      repository: 'example/delivery',
      branch: 'hive/worker-example',
      base_branch: 'main',
      state: 'published',
      number: 7,
      error: null,
      updated_at: 1,
      snapshot: {
        number: 7,
        url: 'https://github.com/example/delivery/pull/7',
        title: 'Deliver change',
        state: 'open',
        draft: true,
        head_sha: 'a'.repeat(40),
        head_branch: 'hive/worker-example',
        base_sha: 'b'.repeat(40),
        base_branch: 'main',
        ci_state: 'none',
        checks: [],
        checked_at: 1,
      },
    },
  })
  expect(await screen.findByRole('link', { name: '#7 · Deliver change' })).toHaveAttribute(
    'href',
    'https://github.com/example/delivery/pull/7'
  )
  expect(screen.getByText(/No checks reported/)).toBeVisible()
  expect(screen.queryByText('Checks passed')).not.toBeInTheDocument()
})

test('requires a refreshed preview after publication fails and preserves the user’s text', async () => {
  vi.spyOn(api, 'requestPullRequest').mockImplementation(async (_workspace, _dispatch, action) => {
    if (action) throw new Error('The accepted commit changed. Refresh.')
    return preview()
  })
  show()
  fireEvent.change(await screen.findByLabelText('PR description'), {
    target: { value: 'Reviewed release notes' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Push and create draft PR' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('The accepted commit changed')
  expect(screen.getByRole('button', { name: 'Push and create draft PR' })).toBeDisabled()
  expect(screen.getByLabelText('PR description')).toHaveValue('Reviewed release notes')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh pull request and CI' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Push and create draft PR' })).toBeEnabled()
  )
})
