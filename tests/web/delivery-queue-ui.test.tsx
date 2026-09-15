// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ActivityCenterDrawer } from '../../web/src/activity/ActivityCenterDrawer.js'
import { DeliveryQueuePanel } from '../../web/src/activity/DeliveryQueuePanel.js'
import * as queueApi from '../../web/src/activity/delivery-queue-api.js'
import * as resourcesApi from '../../web/src/activity/worktree-lifecycle-api.js'
import * as api from '../../web/src/api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'

beforeEach(() => window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en'))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})
test('shows a different queue page and resets pagination when a filter changes', async () => {
  vi.spyOn(api, 'listWorkspaces').mockResolvedValue([])
  vi.spyOn(queueApi, 'getDeliveryQueue').mockImplementation(async (input) => ({
    total: input.state ? 1 : 26,
    offset: input.offset,
    limit: 25,
    items: [
      {
        workspace_id: 'second',
        workspace_name: 'Second workspace',
        worker_name: 'Builder',
        state: 'blocked',
        checked_at: null,
        dispatch: {
          id: String(input.offset),
          workspaceId: 'second',
          toAgentId: 'worker',
          fromAgentId: null,
          text: input.state
            ? 'Filtered blocker'
            : input.offset
              ? 'Older delivery on page two'
              : 'First delivery',
          reportText: null,
          artifacts: [],
          state: 'failed',
          reportOutcome: null,
          reportRevision: 0,
          acceptedAt: null,
          baseHeadSha: null,
          createdAt: 1,
          submittedAt: null,
          deliveredAt: null,
          reportedAt: null,
        },
      },
    ],
  }))
  render(
    <I18nProvider>
      <DeliveryQueuePanel />
    </I18nProvider>
  )
  expect(await screen.findByText('First delivery')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(await screen.findByText('Older delivery on page two')).toBeVisible()
  expect(screen.queryByText('First delivery')).not.toBeInTheDocument()
  expect(screen.getByText('26–26 / 26')).toBeVisible()
  fireEvent.change(screen.getByLabelText('Needs attention'), { target: { value: 'blocked' } })
  expect(await screen.findByText('Filtered blocker')).toBeVisible()
  expect(screen.getByText('1–1 / 1')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
})
test('keeps retained directories accessible after the last workspace is removed', async () => {
  vi.spyOn(api, 'listWorkspaces').mockResolvedValue([])
  vi.spyOn(queueApi, 'getDeliveryQueue').mockResolvedValue({
    total: 0,
    items: [],
    offset: 0,
    limit: 25,
  })
  vi.spyOn(resourcesApi, 'getWorktreeResources').mockResolvedValue({
    total: 0,
    items: [],
    offset: 0,
    limit: 10,
  })
  render(
    <I18nProvider>
      <ActivityCenterDrawer open workspaceId="" onClose={() => {}} />
    </I18nProvider>
  )
  expect(await screen.findByText('No deliveries need attention for these filters.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Workspace activity' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Retained directories' }))
  expect(await screen.findByText('No retained directories to reclaim.')).toBeVisible()
})
