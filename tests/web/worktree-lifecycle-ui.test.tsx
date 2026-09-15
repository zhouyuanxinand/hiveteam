// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WorkerBranchPanel } from '../../web/src/activity/WorkerBranchPanel.js'
import { WorktreeResourcesPanel } from '../../web/src/activity/WorktreeResourcesPanel.js'
import * as api from '../../web/src/activity/worktree-lifecycle-api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'

beforeEach(() => window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en'))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

test('keeps conflict completion disabled until the server reports a staged resolution', async () => {
  let view: api.BranchUpdateView = {
    branch: 'worker-branch',
    target_branch: 'main',
    workspace_path: '/project/worker',
    source_sha: 'a'.repeat(40),
    target_sha: 'b'.repeat(40),
    reason: 'merge_in_progress',
    update: {
      source_sha: 'a'.repeat(40),
      target_sha: 'b'.repeat(40),
      state: 'conflicted',
      error: null,
    },
    conflicts: ['src/value.ts'],
    can_update: false,
    can_continue: false,
    can_abort: true,
    patch: '',
    truncated: false,
  }
  vi.spyOn(api, 'requestBranchUpdate').mockImplementation(async (_workspace, _worker, action) => {
    if (action === 'continue')
      return {
        ...view,
        can_continue: false,
        can_abort: false,
        reason: 'up_to_date',
        update: {
          source_sha: 'a'.repeat(40),
          target_sha: 'b'.repeat(40),
          state: 'complete',
          error: null,
        },
      }
    return view
  })
  render(
    <I18nProvider>
      <WorkerBranchPanel workspaceId="workspace" workerId="worker" onChanged={() => {}} />
    </I18nProvider>
  )
  expect(await screen.findByText('src/value.ts')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Commit resolved merge' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Abandon this branch update' })).toBeEnabled()
  view = { ...view, conflicts: [], can_continue: true, patch: '-conflict\n+resolved' }
  fireEvent.click(screen.getByRole('button', { name: 'Refresh branch update' }))
  await vi.waitFor(() =>
    expect(screen.getByRole('button', { name: 'Commit resolved merge' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Commit resolved merge' }))
  expect(await screen.findByText(/Branch updated. Verify and accept/)).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Abandon this branch update' })
  ).not.toBeInTheDocument()
})

test('shows retained paths and removes the row only after successful cleanup', async () => {
  let removed = false
  let finish: (() => void) | undefined
  const item: api.WorktreeResourceView = {
    id: 'worker',
    workspace_id: 'workspace',
    workspace_name: 'Retired workspace',
    checkout_path: '/hive/worker-worktrees/example',
    branch: 'worker-branch',
    target_branch: 'main',
    head_sha: 'a'.repeat(40),
    target_sha: 'a'.repeat(40),
    can_remove: true,
    reason: null,
    error: null,
  }
  vi.spyOn(api, 'getWorktreeResources').mockImplementation(async () => ({
    total: removed ? 0 : 1,
    items: removed ? [] : [item],
    offset: 0,
    limit: 10,
  }))
  vi.spyOn(api, 'removeWorktreeResource').mockImplementation(
    async () =>
      new Promise((resolve) => {
        finish = () => {
          removed = true
          resolve({ removed: true, branch: item.branch })
        }
      })
  )
  render(
    <I18nProvider>
      <WorktreeResourcesPanel />
    </I18nProvider>
  )
  expect(await screen.findByText(item.checkout_path)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Remove directory, keep branch' }))
  expect(screen.getByRole('button', { name: 'Remove directory, keep branch' })).toBeDisabled()
  expect(screen.getByText(item.checkout_path)).toBeVisible()
  finish?.()
  expect(await screen.findByText('No retained directories to reclaim.')).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent(
    'Directory removed; branch retained: worker-branch'
  )
})
