// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AppProviders } from '../../web/src/AppProviders.js'
import { DataRecoveryPanel } from '../../web/src/knowledge/DataRecoveryPanel.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

test('local recovery UI previews a real backup, requires explicit bindings, and leaves existing data running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-recovery-ui-')),
    project = join(root, 'project')
  mkdirSync(project)
  const server = await startTestServer({ dataDir: join(root, 'data') }),
    nativeFetch = globalThis.fetch
  try {
    const workspace = server.store.createWorkspace(project, 'Fixture project'),
      cookie = await getUiCookie(server.baseUrl)
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
    })
    render(
      <AppProviders>
        <DataRecoveryPanel workspaceId={workspace.id} />
      </AppProviders>
    )
    fireEvent.click(screen.getByText('Local backup, restore and archive'))
    fireEvent.change(screen.getByLabelText('New backup directory'), {
      target: { value: join(root, 'backup') },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create backup' }))
    await screen.findByText(/Backup saved:/, {}, { timeout: 15000 })
    fireEvent.change(screen.getByLabelText('Backup directory'), {
      target: { value: join(root, 'backup') },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }))
    const restore = await screen.findByRole('button', { name: 'Confirm restore to new directory' })
    expect(restore).toBeDisabled()
    fireEvent.change(screen.getByLabelText('New project path: Fixture project'), {
      target: { value: project },
    })
    fireEvent.change(screen.getByLabelText('New data directory'), {
      target: { value: join(root, 'restored') },
    })
    expect(restore).toBeDisabled()
    fireEvent.click(
      screen.getByLabelText('I reviewed the target and path bindings; existing data is retained.')
    )
    fireEvent.click(restore)
    await screen.findByText(/Restored directory is ready/, {}, { timeout: 15000 })
    expect(server.store.getWorkspaceSnapshot(workspace.id).summary.path).toBe(project)
    fireEvent.click(screen.getByRole('button', { name: 'Preview archive scope' }))
    await waitFor(() => expect(screen.getByText('0 records; eligible 0')).toBeVisible())
    expect(screen.getByRole('button', { name: 'Archive selected' })).toBeDisabled()
  } finally {
    cleanup()
    vi.unstubAllGlobals()
    await server.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 30000)
