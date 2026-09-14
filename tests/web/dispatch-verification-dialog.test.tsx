// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DispatchVerificationView } from '../../src/shared/verification.js'
import { DispatchVerificationDialog } from '../../web/src/activity/DispatchVerificationDialog.js'
import * as api from '../../web/src/activity/verification-api.js'
import type { DispatchSummary } from '../../web/src/api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'

const sha = 'a'.repeat(40)
const dispatch: DispatchSummary = {
  id: 'dispatch',
  workspaceId: 'workspace',
  toAgentId: 'worker',
  fromAgentId: null,
  text: 'Verify the implementation',
  reportText: 'Ready',
  artifacts: [],
  state: 'reported',
  reportOutcome: 'success',
  reportRevision: 1,
  acceptedAt: null,
  baseHeadSha: sha,
  createdAt: 1,
  submittedAt: 2,
  deliveredAt: 2,
  reportedAt: 3,
}
const initialView = (): DispatchVerificationView => ({
  headSha: sha,
  isDirty: false,
  unavailableReason: null,
  reportRevision: 1,
  canRun: true,
  canAccept: true,
  staleReason: null,
  accepted: false,
  runs: [
    {
      id: 'run',
      workspaceId: 'workspace',
      dispatchId: 'dispatch',
      reportRevision: 1,
      headSha: sha,
      command: 'node check.cjs',
      state: 'passed',
      output: 'CHECK PASSED',
      outputTruncated: false,
      exitCode: 0,
      error: null,
      startedAt: 1000,
      endedAt: 2000,
      acceptedAt: null,
    },
  ],
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
      <DispatchVerificationDialog dispatch={dispatch} onClose={() => {}} onChanged={() => {}} />
    </I18nProvider>
  )

describe('dispatch verification dialog', () => {
  test('shows command evidence and confirms the version only after server acceptance', async () => {
    let view = initialView()
    vi.spyOn(api, 'getDispatchVerifications').mockImplementation(async () => view)
    let finish: (() => void) | undefined
    vi.spyOn(api, 'updateDispatchVerification').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            view = { ...view, canAccept: false, accepted: true }
            resolve(view)
          }
        })
    )
    show()
    expect(await screen.findByRole('log', { name: 'Command output' })).toHaveTextContent(
      'CHECK PASSED'
    )
    expect(screen.getByLabelText('Verification command')).toHaveValue('node check.cjs')
    fireEvent.click(screen.getByRole('button', { name: 'Accept this verified version' }))
    expect(screen.queryByText('This code version is accepted')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept this verified version' })).toBeDisabled()
    finish?.()
    expect(await screen.findByText('This code version is accepted')).toBeVisible()
  })

  test('starts and cancels verification, then retains evidence when the source changes', async () => {
    let view = initialView()
    vi.spyOn(api, 'getDispatchVerifications').mockImplementation(async () => view)
    vi.spyOn(api, 'startDispatchVerification').mockImplementation(
      async (_workspace, _dispatch, input) => {
        const previous = initialView().runs[0]
        if (!previous) throw new Error('Expected a verification fixture')
        const run = {
          ...previous,
          command: input.command,
          state: 'running' as const,
          exitCode: null,
          endedAt: null,
        }
        view = { ...view, canRun: false, canAccept: false, runs: [run] }
        return run
      }
    )
    vi.spyOn(api, 'updateDispatchVerification').mockImplementation(async () => {
      const previous = view.runs[0]
      if (!previous) throw new Error('Expected a running verification')
      view = {
        ...view,
        canRun: true,
        runs: [{ ...previous, state: 'cancelled', endedAt: 3000 }],
      }
      return view
    })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Run verification' }))
    expect(await screen.findByText('Running', { selector: 'strong' })).toBeVisible()
    expect(screen.getByLabelText('Verification command')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel verification' }))
    expect(await screen.findByText('Cancelled', { selector: 'strong' })).toBeVisible()
    view = {
      ...initialView(),
      headSha: 'b'.repeat(40),
      canAccept: false,
      staleReason: 'code_changed',
    }
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() =>
      expect(screen.getByText('The code version changed. Run verification again.')).toBeVisible()
    )
    expect(screen.getByRole('log')).toHaveTextContent('CHECK PASSED')
    expect(
      screen.queryByRole('button', { name: 'Accept this verified version' })
    ).not.toBeInTheDocument()
  })
})
