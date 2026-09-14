// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceDeliveryPanel } from '../../web/src/activity/WorkspaceDeliveryPanel.js'
import * as api from '../../web/src/api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'

const result = (patch: Partial<api.DispatchSummary> = {}): api.DispatchSummary => ({
  id: 'dispatch-1',
  workspaceId: 'ws-1',
  toAgentId: 'worker-1',
  fromAgentId: null,
  text: 'Fix settings search',
  reportText: 'Updated search and ran the relevant checks.',
  artifacts: ['checks.txt'],
  reportOutcome: 'success',
  reportRevision: 1,
  acceptedAt: null,
  state: 'reported',
  baseHeadSha: null,
  createdAt: 1,
  submittedAt: 2,
  deliveredAt: 2,
  reportedAt: 3,
  ...patch,
})
const workers = [
  {
    id: 'worker-1',
    name: 'Builder',
    role: 'coder' as const,
    status: 'idle' as const,
    pendingTaskCount: 0,
  },
]
const panel = (workspaceId = 'ws-1') => (
  <I18nProvider>
    <WorkspaceDeliveryPanel workspaceId={workspaceId} workers={workers} />
  </I18nProvider>
)
beforeEach(() => window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en'))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('workspace delivery', () => {
  test('shows the report and updates acceptance only after the server accepts it', async () => {
    let dispatch = result()
    vi.spyOn(api, 'listWorkspaceDispatches').mockImplementation(async () => [dispatch])
    vi.spyOn(api, 'acceptDispatchReport').mockImplementation(
      async (_workspaceId, _dispatchId, revision) => {
        expect(revision).toBe(1)
        dispatch = { ...dispatch, acceptedAt: 100 }
        return dispatch
      }
    )
    render(panel())
    fireEvent.click(await screen.findByRole('button', { name: /Delivery.*awaiting acceptance/ }))
    fireEvent.click(screen.getByText('Fix settings search', { selector: 'summary span' }))
    expect(screen.getByText('Updated search and ran the relevant checks.')).toBeVisible()
    expect(screen.getByText('checks.txt')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Accept this report' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Accept this report' })).not.toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: /0 awaiting acceptance/ })).toBeInTheDocument()
    expect(screen.getAllByText('Report accepted')[0]).toBeVisible()
  })

  test('blocked reports offer feedback and return to in-progress after successful delivery', async () => {
    let dispatch = result({ reportOutcome: 'blocked', reportText: 'Need the API contract.' })
    vi.spyOn(api, 'listWorkspaceDispatches').mockImplementation(async () => [dispatch])
    vi.spyOn(api, 'sendDispatchFeedback').mockImplementation(
      async (_workspaceId, _dispatchId, text) => {
        expect(text).toBe('Use the documented response shape.')
        dispatch = { ...dispatch, state: 'submitted', reportText: null, reportOutcome: null }
        return dispatch
      }
    )
    render(panel())
    fireEvent.click(await screen.findByRole('button', { name: /1 need attention/ }))
    fireEvent.click(screen.getByText('Fix settings search', { selector: 'summary span' }))
    expect(screen.queryByRole('button', { name: 'Accept this report' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Required changes or missing information'), {
      target: { value: 'Use the documented response shape.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Return to worker' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /1 in progress.*0 need attention/ })
      ).toBeInTheDocument()
    )
    expect(screen.queryByText('Need the API contract.')).not.toBeInTheDocument()
  })

  test('a rejected acceptance stays unaccepted and exposes the error', async () => {
    vi.spyOn(api, 'listWorkspaceDispatches').mockResolvedValue([result()])
    vi.spyOn(api, 'acceptDispatchReport').mockRejectedValue(
      new Error('The report changed. Refresh and review it again.')
    )
    render(panel())
    fireEvent.click(await screen.findByRole('button', { name: /1 awaiting acceptance/ }))
    fireEvent.click(screen.getByText('Fix settings search', { selector: 'summary span' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept this report' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The report changed.')
    expect(screen.getByRole('button', { name: /1 awaiting acceptance/ })).toBeInTheDocument()
    expect(screen.queryByText('Report accepted')).not.toBeInTheDocument()
  })
})
