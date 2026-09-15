// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DispatchIntegrationPanel } from '../../web/src/activity/DispatchIntegrationPanel.js'
import * as api from '../../web/src/activity/integration-api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'

const preview = (): api.IntegrationPreview => ({
  worktree: {
    branch: 'hive/worker-example',
    workspace_path: 'C:/project/worktrees/example',
    target_branch: 'main',
  },
  source_sha: 'a'.repeat(40),
  target_sha: 'b'.repeat(40),
  verification_id: 'verification',
  can_integrate: true,
  reason: null,
  integrated_at: null,
  patch: '-original\n+delivered',
  truncated: false,
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
      <DispatchIntegrationPanel
        workspaceId="workspace"
        dispatchId="dispatch"
        onChanged={() => {}}
      />
    </I18nProvider>
  )

test('renders exact source, target and diff, and marks integration only after the server completes it', async () => {
  let finish: (() => void) | undefined
  vi.spyOn(api, 'requestDispatchIntegration').mockImplementation(
    async (_workspace, _dispatch, request) => {
      if (!request) return preview()
      return new Promise((resolve) => {
        finish = () => resolve({ ...request, can_integrate: false, integrated_at: 1000 })
      })
    }
  )
  show()
  expect(await screen.findByText('hive/worker-example')).toBeVisible()
  expect(screen.getByText('aaaaaaaaaaaa')).toBeVisible()
  expect(screen.getByText('bbbbbbbbbbbb')).toBeVisible()
  expect(screen.getByText(/\+delivered/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Integrate into main' }))
  expect(screen.getByRole('button', { name: 'Integrating…' })).toBeDisabled()
  expect(screen.queryByText(/Accepted version integrated/)).not.toBeInTheDocument()
  finish?.()
  expect(await screen.findByText(/Accepted version integrated/)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Integrate into main' })).not.toBeInTheDocument()
})

test('shows target divergence and requires a refreshed preview after a rejected integration', async () => {
  let current: api.IntegrationPreview = {
    ...preview(),
    can_integrate: false,
    reason: 'target_diverged',
  }
  vi.spyOn(api, 'requestDispatchIntegration').mockImplementation(
    async (_workspace, _dispatch, request) => {
      if (request) throw new Error('The target changed during review')
      return current
    }
  )
  show()
  expect(await screen.findByText(/The target branch has diverged/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Integrate into main' })).toBeDisabled()
  current = preview()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh integration preview' }))
  await screen.findByText('hive/worker-example')
  // The prior reason disappears only when the refreshed response is rendered.
  await vi.waitFor(() =>
    expect(screen.getByRole('button', { name: 'Integrate into main' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Integrate into main' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('The target changed during review')
  expect(screen.getByRole('button', { name: 'Integrate into main' })).toBeDisabled()
  expect(screen.queryByText(/Accepted version integrated/)).not.toBeInTheDocument()
})
