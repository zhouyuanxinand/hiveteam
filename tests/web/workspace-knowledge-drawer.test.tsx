// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { WorkspaceKnowledgeDrawer } from '../../web/src/knowledge/WorkspaceKnowledgeDrawer.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  })

describe('workspace knowledge drawer', () => {
  test('switches between searchable Memory and Workflows surfaces', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/memory/settings'))
        return jsonResponse({ dream_enabled: false, enabled: true })
      if (url.includes('/memory?')) {
        return jsonResponse([
          {
            body: 'Use pnpm for all workspace scripts.',
            confidence: 1,
            created_at: 100,
            created_by_agent_id: null,
            created_by_agent_name: null,
            disabled: false,
            id: 'memory-1',
            kind: 'decision',
            last_injected_at: null,
            pinned: true,
            procedure_ref: null,
            scope: 'workspace',
            source: 'manual',
            status: 'active',
            tags: ['tooling'],
            updated_at: 200,
            workspace_id: 'workspace-1',
          },
        ])
      }
      if (url.endsWith('/workflows')) {
        return jsonResponse({
          runs: [],
          schedules: [],
          workflows: [
            {
              description: 'Validate a release build',
              id: 'release-check.ts',
              name: 'Release check',
              path: '.hive/workflows/release-check.ts',
              updated_at: 300,
            },
          ],
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <WorkspaceKnowledgeDrawer
        initialTab="memory"
        onClose={vi.fn()}
        open
        workspaceId="workspace-1"
      />
    )

    expect(await screen.findByText('Use pnpm for all workspace scripts.')).toBeInTheDocument()
    expect(screen.getByText('#tooling')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Workflows' }))

    expect(await screen.findByText('Release check')).toBeInTheDocument()
    expect(screen.getByText('.hive/workflows/release-check.ts')).toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
  })

  test('collects and displays structured procedure references', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/memory/settings')) {
        return jsonResponse({ dream_enabled: false, enabled: true })
      }
      if (url.includes('/memory?')) {
        return jsonResponse([
          {
            body: 'Run the release checklist before deployment.',
            confidence: 1,
            created_at: 100,
            created_by_agent_id: null,
            created_by_agent_name: null,
            disabled: false,
            id: 'memory-procedure',
            kind: 'procedure_ref',
            last_injected_at: null,
            pinned: false,
            procedure_ref: {
              id: '.hive/workflows/release-check.ts',
              title: 'Release checklist',
              type: 'workflow',
            },
            scope: 'workspace',
            source: 'manual',
            status: 'active',
            tags: [],
            updated_at: 200,
            workspace_id: 'workspace-1',
          },
        ])
      }
      if (url.endsWith('/memory') && init?.method === 'POST') {
        return jsonResponse({}, 201)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <WorkspaceKnowledgeDrawer
        initialTab="memory"
        onClose={vi.fn()}
        open
        workspaceId="workspace-1"
      />
    )

    expect(await screen.findByText('.hive/workflows/release-check.ts')).toBeInTheDocument()
    expect(screen.getByText('Release checklist')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }))
    fireEvent.change(screen.getByLabelText('Memory kind'), {
      target: { value: 'procedure_ref' },
    })

    expect(screen.getByText('Procedure reference')).toBeInTheDocument()
    expect(screen.getByLabelText('Reference type')).toBeInTheDocument()
    expect(screen.getByLabelText('Reference ID')).toBeInTheDocument()
  })
})
