// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DispatchDiffDialog } from '../../web/src/activity/DispatchDiffDialog.js'
import type { DispatchSummary } from '../../web/src/api.js'
import { I18nProvider } from '../../web/src/i18n.js'

const getDispatchDiff = vi.hoisted(() => vi.fn())
const sendDispatchFeedback = vi.hoisted(() => vi.fn())

vi.mock('../../web/src/api.js', () => ({
  getDispatchDiff: (...args: unknown[]) => getDispatchDiff(...args),
  sendDispatchFeedback: (...args: unknown[]) => sendDispatchFeedback(...args),
}))

const dispatch: DispatchSummary = {
  artifacts: [],
  baseHeadSha: 'abc1234def56789000000000000000000000cafe',
  createdAt: 1_700_000_000_000,
  deliveredAt: null,
  fromAgentId: 'workspace-1:orchestrator',
  id: 'dispatch-1',
  reportedAt: null,
  reportText: null,
  state: 'submitted',
  submittedAt: 1_700_000_000_100,
  text: 'Update the readme',
  toAgentId: 'worker-1',
  workspaceId: 'workspace-1',
}

const renderDialog = (open = true) =>
  render(
    <I18nProvider>
      <DispatchDiffDialog
        dispatch={dispatch}
        onClose={() => {}}
        open={open}
        targetLabel="Coder"
        workspaceId="workspace-1"
      />
    </I18nProvider>
  )

beforeEach(() => {
  window.localStorage.clear()
  getDispatchDiff.mockReset()
  sendDispatchFeedback.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('DispatchDiffDialog', () => {
  test('renders the returned patch with line kinds and untracked files', async () => {
    getDispatchDiff.mockResolvedValue({
      baseHeadSha: dispatch.baseHeadSha,
      dispatchId: dispatch.id,
      headSha: dispatch.baseHeadSha,
      patch: [
        'diff --git a/README.md b/README.md',
        'index 1111111..2222222 100644',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1 +1 @@',
        '-# before',
        '+# after',
      ].join('\n'),
      truncated: false,
      untrackedFiles: ['notes.txt'],
    })

    renderDialog()

    expect(getDispatchDiff).toHaveBeenCalledWith('workspace-1', 'dispatch-1')
    const patch = await screen.findByTestId('dispatch-diff-patch')
    expect(patch).toHaveTextContent('+# after')
    expect(patch).toHaveTextContent('-# before')
    expect(patch.querySelector('.dispatch-diff-line--add')).toHaveTextContent('+# after')
    expect(patch.querySelector('.dispatch-diff-line--del')).toHaveTextContent('-# before')
    expect(patch.querySelector('.dispatch-diff-line--hunk')).toHaveTextContent('@@ -1 +1 @@')
    expect(screen.getByText('notes.txt')).toBeInTheDocument()
  })

  test('shows the empty state when nothing changed', async () => {
    getDispatchDiff.mockResolvedValue({
      baseHeadSha: dispatch.baseHeadSha,
      dispatchId: dispatch.id,
      headSha: dispatch.baseHeadSha,
      patch: '',
      truncated: false,
      untrackedFiles: [],
    })

    renderDialog()

    expect(
      await screen.findByText(/No tracked file changes|没有已跟踪文件的改动/)
    ).toBeInTheDocument()
  })

  test('surfaces load errors instead of hanging', async () => {
    getDispatchDiff.mockRejectedValue(new Error('Dispatch has no Git baseline'))

    renderDialog()

    expect(await screen.findByRole('alert')).toHaveTextContent('Dispatch has no Git baseline')
  })

  test('sends review feedback to the worker and confirms delivery', async () => {
    getDispatchDiff.mockResolvedValue({
      baseHeadSha: dispatch.baseHeadSha,
      dispatchId: dispatch.id,
      headSha: dispatch.baseHeadSha,
      patch: '',
      truncated: false,
      untrackedFiles: [],
    })
    sendDispatchFeedback.mockResolvedValue({ ...dispatch, state: 'submitted' })

    renderDialog()

    const sendButton = screen.getByTestId('dispatch-feedback-send')
    expect(sendButton).toBeDisabled()

    fireEvent.change(screen.getByTestId('dispatch-feedback-input'), {
      target: { value: '  请把按钮换成红色  ' },
    })
    expect(sendButton).toBeEnabled()
    fireEvent.click(sendButton)

    expect(sendDispatchFeedback).toHaveBeenCalledWith(
      'workspace-1',
      'dispatch-1',
      '请把按钮换成红色'
    )
    expect(await screen.findByRole('status')).toHaveTextContent(/Feedback sent|反馈已送达/)
    expect((screen.getByTestId('dispatch-feedback-input') as HTMLTextAreaElement).value).toBe('')
  })

  test('shows the server error when feedback cannot be delivered', async () => {
    getDispatchDiff.mockResolvedValue({
      baseHeadSha: dispatch.baseHeadSha,
      dispatchId: dispatch.id,
      headSha: dispatch.baseHeadSha,
      patch: '',
      truncated: false,
      untrackedFiles: [],
    })
    sendDispatchFeedback.mockRejectedValue(new Error('The worker is not running'))

    renderDialog()

    fireEvent.change(screen.getByTestId('dispatch-feedback-input'), {
      target: { value: 'please fix' },
    })
    fireEvent.click(screen.getByTestId('dispatch-feedback-send'))

    expect(await screen.findByRole('alert')).toHaveTextContent('The worker is not running')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
