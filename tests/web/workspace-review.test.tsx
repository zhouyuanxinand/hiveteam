// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ReviewDocumentState } from '../../src/shared/workspace-review.js'
import { ClarificationNotice } from '../../web/src/review/ClarificationNotice.js'
import { PlanEditor } from '../../web/src/review/PlanEditor.js'
import { ReviewMarkdown } from '../../web/src/review/ReviewMarkdown.js'
import { WorkspaceComposer } from '../../web/src/review/WorkspaceComposer.js'
import { WorkspacePlanPanel } from '../../web/src/review/WorkspacePlanPanel.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})
const original: ReviewDocumentState = {
  document: {
    path: 'docs/prototype-plan.md',
    content: '# Original plan\n\nUse a CLI.\n',
    revision: 'rev1',
  },
  draft: null,
  confirmed_revision: null,
  submissions: [],
}
const Harness = ({ initial = original }: { initial?: ReviewDocumentState }) => {
  const [state, setState] = useState(initial)
  return <PlanEditor workspaceId="w1" state={state} onUpdate={setState} onReload={() => {}} />
}

test('member replies and drafts remain recipient-scoped when switching windows', async () => {
  const payloads: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    payloads.push(body)
    return Response.json({
      ...body,
      kind: 'answer',
      path: null,
      status: 'submitted',
      error: null,
      created_at: 1,
    })
  })
  const view = render(
    <WorkspaceComposer workspaceId="w1" recipient={{ id: 'alice', name: 'Alice' }} />
  )
  fireEvent.change(screen.getByLabelText('Reply to Alice'), {
    target: { value: 'Alice only\nCustom reply' },
  })
  view.rerender(<WorkspaceComposer workspaceId="w1" recipient={{ id: 'bob', name: 'Bob' }} />)
  expect(screen.getByLabelText('Reply to Bob')).toHaveValue('')
  fireEvent.change(screen.getByLabelText('Reply to Bob'), { target: { value: 'Bob draft' } })
  view.rerender(<WorkspaceComposer workspaceId="w1" />)
  expect(screen.getByLabelText('Your reply')).toHaveValue('')
  view.rerender(<WorkspaceComposer workspaceId="w1" recipient={{ id: 'alice', name: 'Alice' }} />)
  expect(screen.getByLabelText('Reply to Alice')).toHaveValue('Alice only\nCustom reply')
  expect(screen.getByText('Sent only to this member, not to Orchestrator.')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Plan documents' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
  await waitFor(() => expect(screen.getByLabelText('Reply to Alice')).toHaveValue(''))
  expect(payloads).toHaveLength(1)
  expect(payloads[0]).toMatchObject({ agent_id: 'alice', text: 'Alice only\nCustom reply' })
  view.rerender(<WorkspaceComposer workspaceId="w1" recipient={{ id: 'bob', name: 'Bob' }} />)
  expect(screen.getByLabelText('Reply to Bob')).toHaveValue('Bob draft')
})

test('the clarification notice opens only the assigned member and disappears when reported', () => {
  const worker = {
    id: 'alice',
    name: 'Alice',
    role: 'coder' as const,
    status: 'working' as const,
    pendingTaskCount: 1,
    clarification: { dispatchId: 'd1', skillName: 'grilling', active: true },
  }
  const Notice = () => {
    const [opened, setOpened] = useState('')
    return (
      <>
        <ClarificationNotice workers={[worker]} onOpen={setOpened} />
        <output>{opened}</output>
      </>
    )
  }
  const view = render(<Notice />)
  fireEvent.click(screen.getByRole('button', { name: 'Answer in member window · Alice' }))
  expect(screen.getByRole('status')).toHaveTextContent('alice')
  view.rerender(
    <ClarificationNotice
      workers={[{ ...worker, clarification: { ...worker.clarification, active: false } }]}
      onOpen={() => {}}
    />
  )
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
test('free-form answers preserve multiline text, question context and drafts across remounts', async () => {
  const payloads: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    payloads.push(body)
    return Response.json({
      ...body,
      kind: 'answer',
      path: null,
      status: 'submitted',
      error: null,
      created_at: 1,
    })
  })
  const first = render(<WorkspaceComposer workspaceId="w1" onOpenPlans={() => {}} />)
  fireEvent.change(screen.getByLabelText('Your reply'), {
    target: { value: 'Neither.\n我想自行填写。' },
  })
  fireEvent.change(screen.getByLabelText('Question or earlier answer to revise (optional)'), {
    target: { value: 'Q28' },
  })
  first.unmount()
  render(<WorkspaceComposer workspaceId="w1" onOpenPlans={() => {}} />)
  expect(screen.getByLabelText('Your reply')).toHaveValue('Neither.\n我想自行填写。')
  fireEvent.keyDown(screen.getByLabelText('Your reply'), { key: 'Enter' })
  expect(payloads).toHaveLength(0)
  fireEvent.keyDown(screen.getByLabelText('Your reply'), {
    key: 'Enter',
    ctrlKey: true,
    isComposing: true,
  })
  expect(payloads).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
  await waitFor(() => expect(screen.getByLabelText('Your reply')).toHaveValue(''))
  expect(payloads).toHaveLength(1)
  expect(payloads[0]).toMatchObject({ question: 'Q28', text: 'Neither.\n我想自行填写。' })
  expect(screen.getByRole('status')).toHaveTextContent('Submitted to the terminal')
})

test('failed answer delivery keeps content and retries the same id instead of silently duplicating', async () => {
  const requests: string[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { request_id: string }
    requests.push(body.request_id)
    if (requests.length === 1) throw new Error('Connection lost')
    return Response.json({
      request_id: body.request_id,
      kind: 'answer',
      path: null,
      status: 'blocked',
      error: 'Orchestrator is stopped',
      created_at: 1,
    })
  })
  render(<WorkspaceComposer workspaceId="w1" onOpenPlans={() => {}} />)
  fireEvent.change(screen.getByLabelText('Your reply'), { target: { value: 'Keep this answer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('Your reply')).toHaveValue('Keep this answer')
  fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Not sent'))
  expect(requests[0]).toBe(requests[1])
  expect(screen.getByLabelText('Your reply')).toHaveValue('Keep this answer')
})

test('a lost POST response preserves the request across reload and checks it without resending', async () => {
  let posts = 0
  let attemptedId = ''
  const queries: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      posts++
      attemptedId = JSON.parse(String(init.body)).request_id
      throw new Error('Response lost after terminal accepted input')
    }
    queries.push(url)
    return Response.json({
      request_id: attemptedId,
      kind: 'answer',
      path: null,
      status: 'submitted',
      error: null,
      created_at: 1,
    })
  })
  const first = render(<WorkspaceComposer workspaceId="w1" onOpenPlans={() => {}} />)
  fireEvent.change(screen.getByLabelText('Your reply'), { target: { value: 'Still my answer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Check submission status' })).toBeEnabled()
  expect(screen.getByRole('status')).toHaveTextContent('has not been verified')
  first.unmount()
  render(<WorkspaceComposer workspaceId="w1" onOpenPlans={() => {}} />)
  await waitFor(() => expect(screen.getByLabelText('Your reply')).toHaveValue(''))
  expect(screen.getByRole('status')).toHaveTextContent('Submitted to the terminal')
  expect(posts).toBe(1)
  expect(queries).toEqual([`/api/workspaces/w1/review/submissions/${attemptedId}`])
})

test('a saved draft without browser submission history never claims it was not sent', () => {
  render(
    <Harness
      initial={{
        ...original,
        draft: {
          path: original.document.path,
          content: '# Edit',
          base_content: original.document.content,
          base_revision: 'rev1',
          note: '',
          version: 1,
          updated_at: 1,
        },
        submissions: [
          {
            request_id: crypto.randomUUID(),
            kind: 'review',
            path: original.document.path,
            status: 'submitted',
            error: null,
            created_at: 1,
          },
        ],
      }}
    />
  )
  expect(screen.getByText('Draft saved')).toBeInTheDocument()
  expect(screen.queryByText('Draft saved — not sent')).toBeNull()
})

test('edits and previews a draft, displays actual differences, saves independently then sends its exact version', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url, body })
    if (url.endsWith('/draft'))
      return Response.json({
        ...body,
        base_content: original.document.content,
        version: 1,
        updated_at: 1,
      })
    return Response.json({
      request_id: body.request_id,
      kind: 'review',
      path: original.document.path,
      status: 'submitted',
      created_at: 1,
      error: null,
    })
  })
  render(<Harness />)
  expect(screen.getByRole('heading', { name: 'Original plan' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: 'Edit draft' }))
  fireEvent.change(screen.getByLabelText('Your draft'), {
    target: { value: '# Revised plan\n\nUse a page.\n' },
  })
  fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
  expect(screen.getByRole('tabpanel')).toHaveTextContent('-Use a CLI.')
  expect(screen.getByRole('tabpanel')).toHaveTextContent('+Use a page.')
  expect(screen.getByRole('button', { name: 'Confirm source version' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  await waitFor(() => expect(screen.getByText('Draft saved')).toBeInTheDocument())
  expect(calls).toHaveLength(1)
  expect(calls[0]?.body).toMatchObject({
    content: '# Revised plan\n\nUse a page.\n',
    base_revision: 'rev1',
    expected_version: 0,
  })
  fireEvent.click(screen.getByRole('tab', { name: 'Preview' }))
  expect(screen.getByRole('heading', { name: 'Revised plan' })).toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('Source file'))
  expect(screen.getByRole('heading', { name: 'Original plan' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Send changes for review' }))
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('Submitted to the terminal')
  )
  expect(calls).toHaveLength(2)
  expect(calls[1]?.body).toMatchObject({ path: original.document.path, draft_version: 1 })
})

test('retains browser edits across closing and highlights a newer source without overwriting the draft', () => {
  const first = render(<Harness />)
  fireEvent.click(screen.getByRole('tab', { name: 'Edit draft' }))
  fireEvent.change(screen.getByLabelText('Your draft'), { target: { value: 'My unsaved edit' } })
  first.unmount()
  render(
    <Harness
      initial={{
        ...original,
        document: { ...original.document, revision: 'rev2', content: '# New model plan' },
      }}
    />
  )
  expect(screen.getByRole('alert')).toHaveTextContent('source changed')
  expect(screen.getByRole('button', { name: 'Send changes for review' })).toBeDisabled()
  fireEvent.click(screen.getByRole('tab', { name: 'Edit draft' }))
  expect(screen.getByLabelText('Your draft')).toHaveValue('My unsaved edit')
})

test('opens the plan panel, lists Markdown documents and selects the actual plan', async () => {
  vi.stubGlobal('fetch', async (url: string) =>
    Response.json(
      url.endsWith('/documents')
        ? { paths: ['.hive/tasks.md', original.document.path], truncated: false }
        : original
    )
  )
  render(<WorkspacePlanPanel workspaceId="w1" open onClose={() => {}} />)
  await screen.findByRole('heading', { name: 'Original plan' })
  expect(screen.getByRole('combobox')).toHaveValue(original.document.path)
  expect(screen.getByRole('button', { name: 'Confirm source version' })).toBeEnabled()
})

test('preview removes active markup and automatic external resource loads', () => {
  const view = render(
    <ReviewMarkdown
      content={
        '# Plan\n<script>alert(1)</script><img src="https://bad.example/track"><iframe src="https://bad.example"></iframe>\n[unsafe](javascript:alert(1))'
      }
    />
  )
  expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument()
  expect(view.container.querySelectorAll('script,img,iframe')).toHaveLength(0)
  expect(view.container.querySelector('a')?.getAttribute('href')).toBeNull()
})

test('keeps the editor and unsaved content mounted during source reloads', async () => {
  let resolveReload: ((response: Response) => void) | undefined
  let reads = 0
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.endsWith('/documents'))
      return Response.json({ paths: [original.document.path], truncated: false })
    if (++reads === 1) return Response.json(original)
    return new Promise<Response>((resolve) => {
      resolveReload = resolve
    })
  })
  render(<WorkspacePlanPanel workspaceId="w1" open onClose={() => {}} />)
  await screen.findByRole('heading', { name: 'Original plan' })
  fireEvent.click(screen.getByRole('tab', { name: 'Edit draft' }))
  const editor = screen.getByLabelText('Your draft')
  fireEvent.change(editor, { target: { value: 'Keep this edit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Reload source' }))
  await screen.findByText('Loading documents…')
  expect(screen.getByLabelText('Your draft')).toBe(editor)
  expect(editor).toHaveValue('Keep this edit')
  resolveReload?.(
    Response.json({ ...original, document: { ...original.document, revision: 'rev2' } })
  )
  await screen.findByRole('alert')
  expect(screen.getByLabelText('Your draft')).toBe(editor)
  expect(editor).toHaveValue('Keep this edit')
})

test('retries an initial list error instead of leaving the panel empty', async () => {
  let attempts = 0
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.endsWith('/documents')) {
      if (++attempts === 1) throw new Error('Offline')
      return Response.json({ paths: [original.document.path], truncated: false })
    }
    return Response.json(original)
  })
  render(<WorkspacePlanPanel workspaceId="w1" open onClose={() => {}} />)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Reload source' }))
  await screen.findByRole('heading', { name: 'Original plan' })
  expect(screen.queryByRole('alert')).toBeNull()
})

test('opens only listed Markdown links inside the panel and preserves links after rerenders', () => {
  const visited: string[] = []
  const content =
    '[Notes](./design-discussion.md) [Outside](../../secret.md) [Web](https://example.com)'
  const view = render(
    <ReviewMarkdown
      content={content}
      path="docs/prototype-plan.md"
      documentPaths={['docs/design-discussion.md']}
      onNavigate={(path) => visited.push(path)}
    />
  )
  fireEvent.click(screen.getByText('Notes'))
  view.rerender(
    <ReviewMarkdown
      content={content}
      path="docs/prototype-plan.md"
      documentPaths={['docs/design-discussion.md']}
      onNavigate={(path) => visited.push(path)}
    />
  )
  fireEvent.click(screen.getByText('Notes'))
  expect(visited).toEqual(['docs/design-discussion.md', 'docs/design-discussion.md'])
  expect(screen.getByText('Outside')).not.toHaveAttribute('href')
  expect(screen.getByText('Web')).toHaveAttribute('target', '_blank')
  expect(screen.getByText('Web')).toHaveAttribute('rel', 'noopener noreferrer')
})

test('restores a known submission on reopen and supports keyboard tab navigation', () => {
  const id = crypto.randomUUID()
  localStorage.setItem(
    'hive:plan-draft:w1:docs/prototype-plan.md',
    JSON.stringify({
      content: '# Revised',
      note: '',
      base_revision: 'rev1',
      base_content: original.document.content,
      expected_version: 1,
      request_id: id,
    })
  )
  render(
    <Harness
      initial={{
        ...original,
        draft: {
          path: original.document.path,
          content: '# Revised',
          note: '',
          base_revision: 'rev1',
          base_content: original.document.content,
          version: 1,
          updated_at: 1,
        },
        submissions: [
          {
            request_id: id,
            kind: 'review',
            path: original.document.path,
            status: 'submitted',
            error: null,
            created_at: 1,
          },
        ],
      }}
    />
  )
  expect(screen.getByRole('status')).toHaveTextContent('Submitted to the terminal')
  expect(screen.queryByText('Draft saved — not sent')).toBeNull()
  screen.getByRole('tab', { name: 'Preview' }).focus()
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Preview' }), { key: 'ArrowRight' })
  expect(screen.getByLabelText('Your draft')).toHaveValue('# Revised')
  expect(screen.getByRole('tab', { name: 'Edit draft' })).toHaveFocus()
})
