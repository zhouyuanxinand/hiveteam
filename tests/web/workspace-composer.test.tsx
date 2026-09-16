// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { I18nProvider } from '../../web/src/i18n.js'
import { WorkspaceComposer } from '../../web/src/review/WorkspaceComposer.js'
import { WorkspacePlanPanel } from '../../web/src/review/WorkspacePlanPanel.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

const disclosure = () => screen.getByRole('button', { name: 'Supplementary reply / plan feedback' })

test('starts collapsed and opens plan documents without opening another input', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ paths: [], truncated: false }))
  const Workspace = () => {
    const [plansOpen, setPlansOpen] = useState(false)
    return (
      <>
        <WorkspaceComposer workspaceId="w1" onOpenPlans={() => setPlansOpen(true)} />
        {plansOpen ? (
          <WorkspacePlanPanel workspaceId="w1" open onClose={() => setPlansOpen(false)} />
        ) : null}
      </>
    )
  }
  render(<Workspace />)
  expect(disclosure()).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Send reply' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Plan documents' }))
  await screen.findByText('No Markdown documents yet. Ask Orchestrator to save a plan in docs/.')
  fireEvent.click(screen.getByRole('button', { name: 'Close plan documents' }))
  expect(disclosure()).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})

test('expands with focus and keeps both draft fields and the request id when collapsed', () => {
  render(<WorkspaceComposer workspaceId="w1" />)
  fireEvent.click(disclosure())
  const answer = screen.getByRole('textbox', { name: 'Your reply' })
  expect(answer).toHaveFocus()
  expect(disclosure()).toHaveAttribute('aria-expanded', 'true')
  const panelId = disclosure().getAttribute('aria-controls') ?? ''
  expect(document.getElementById(panelId)).toBeVisible()
  expect(screen.getByText(/Sent to the same Orchestrator/)).toBeVisible()
  fireEvent.change(answer, { target: { value: 'Supplementary notes\n保留草稿' } })
  fireEvent.click(screen.getByText('Question or earlier answer to revise (optional)'))
  fireEvent.change(screen.getByRole('textbox', { name: /Question or earlier answer/ }), {
    target: { value: 'Question 3' },
  })
  const storedDraft = localStorage.getItem('hive:answer:w1')
  fireEvent.click(disclosure())
  expect(document.getElementById(panelId)).not.toBeVisible()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByText('Draft retained')).toBeVisible()
  fireEvent.click(disclosure())
  expect(screen.getByRole('textbox', { name: 'Your reply' })).toHaveValue(
    'Supplementary notes\n保留草稿'
  )
  expect(screen.getByRole('textbox', { name: /Question or earlier answer/ })).toHaveValue(
    'Question 3'
  )
  expect(localStorage.getItem('hive:answer:w1')).toBe(storedDraft)
})

test('keeps workspace drafts isolated and advertises restored drafts without expanding', () => {
  const view = render(<WorkspaceComposer workspaceId="w1" />)
  fireEvent.click(disclosure())
  fireEvent.change(screen.getByRole('textbox', { name: 'Your reply' }), {
    target: { value: 'Only for workspace one' },
  })
  view.rerender(<WorkspaceComposer workspaceId="w2" />)
  expect(disclosure()).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('Draft retained')).not.toBeInTheDocument()
  fireEvent.click(disclosure())
  expect(screen.getByRole('textbox', { name: 'Your reply' })).toHaveValue('')
  view.rerender(<WorkspaceComposer workspaceId="w1" />)
  expect(disclosure()).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('Draft retained')).toBeVisible()
  fireEvent.click(disclosure())
  expect(screen.getByRole('textbox', { name: 'Your reply' })).toHaveValue('Only for workspace one')
})

test('continues delivery while collapsed and shows the receipt without resending', async () => {
  let respond: ((response: Response) => void) | undefined
  const bodies: Array<{ request_id: string; text: string }> = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Promise<Response>((resolve) => {
      respond = resolve
    })
  })
  render(<WorkspaceComposer workspaceId="w1" />)
  fireEvent.click(disclosure())
  fireEvent.change(screen.getByRole('textbox', { name: 'Your reply' }), {
    target: { value: 'Send only once' },
  })
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Your reply' }), {
    key: 'Enter',
    ctrlKey: true,
  })
  expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled()
  fireEvent.click(disclosure())
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Submission has not been verified')
  respond?.(
    Response.json({
      request_id: bodies[0]?.request_id,
      kind: 'answer',
      path: null,
      status: 'submitted',
      error: null,
      created_at: 1,
    })
  )
  await waitFor(() => {
    expect(screen.getByRole('status')).toHaveTextContent('Submitted to the terminal')
    expect(screen.queryByText('Draft retained')).not.toBeInTheDocument()
  })
  expect(disclosure()).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(disclosure())
  expect(screen.getByRole('textbox', { name: 'Your reply' })).toHaveValue('')
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toMatchObject({ text: 'Send only once' })
})

test('keeps delivery errors visible when collapsed and restores the unsent reply', async () => {
  vi.stubGlobal('fetch', async () => {
    throw new Error('Connection lost')
  })
  render(<WorkspaceComposer workspaceId="w1" />)
  fireEvent.click(disclosure())
  fireEvent.change(screen.getByRole('textbox', { name: 'Your reply' }), {
    target: { value: 'Do not lose this reply' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
  fireEvent.click(disclosure())
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost')
  expect(screen.getByRole('button', { name: 'Check submission status' })).toBeVisible()
  expect(screen.getByText('Draft retained')).toBeVisible()
  fireEvent.click(disclosure())
  expect(screen.getByRole('textbox', { name: 'Your reply' })).toHaveValue('Do not lose this reply')
})

test('uses Chinese labels and keeps member interview replies directly available', () => {
  localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'zh')
  const view = render(
    <I18nProvider>
      <WorkspaceComposer workspaceId="w1" onOpenPlans={() => {}} />
    </I18nProvider>
  )
  expect(screen.getByRole('button', { name: '补充回答 / 方案反馈' })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  expect(screen.getByRole('button', { name: '方案文档' })).toBeVisible()
  view.rerender(
    <I18nProvider>
      <WorkspaceComposer workspaceId="w1" recipient={{ id: 'alice', name: 'Alice' }} />
    </I18nProvider>
  )
  expect(screen.getByRole('textbox', { name: '回答给 Alice' })).toBeVisible()
  expect(screen.getByText('仅发送给这位成员，不转发给 Orchestrator。')).toBeVisible()
  expect(screen.queryByRole('button', { name: '补充回答 / 方案反馈' })).not.toBeInTheDocument()
})
