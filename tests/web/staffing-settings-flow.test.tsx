// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { StaffingSettings } from '../../web/src/worker/StaffingSettings.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const nativeFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
test('desktop settings persist explicit preset authorization and show retained members', async () => {
  const server = await startTestServer()
  try {
    const workspace = server.store.createWorkspace(server.dataDir, 'Staffing settings')
    const preset = server.store.settings.createCommandPreset({
      command: process.execPath,
      args: [],
      displayName: 'Local fixture',
      env: {},
      resumeArgsTemplate: null,
      sessionIdCapture: null,
      yoloArgsTemplate: null,
    })
    const retired = server.store.addWorker(workspace.id, {
      name: 'Archived reviewer',
      role: 'reviewer',
    })
    server.store.workerLifecycle.dismiss(workspace.id, retired.id)
    const cookie = await getUiCookie(server.baseUrl)
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
    })
    render(<StaffingSettings workspaceId={workspace.id} />)
    fireEvent.click(screen.getByText('Dynamic staffing and retired members'))
    const enabled = await screen.findByRole(
      'checkbox',
      { name: 'Allow dynamic members' },
      { timeout: 20000 }
    )
    expect(enabled).not.toBeChecked()
    fireEvent.click(enabled)
    expect(screen.getByRole('button', { name: 'Save staffing settings' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Local fixture' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum temporary members' }), {
      target: { value: '3' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save staffing settings' }))
    await screen.findByText('Staffing settings saved.')
    expect(server.store.workerLifecycle.readPolicy(workspace.id)).toEqual({
      enabled: true,
      allowed_command_preset_ids: [preset.id],
      max_ephemeral_workers: 3,
    })
    fireEvent.click(screen.getByText('Archived reviewer · reviewer'))
    expect(screen.getByText(retired.id)).toBeVisible()
    fireEvent.click(enabled)
    await waitFor(() => expect(screen.queryByText('Staffing settings saved.')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Save staffing settings' }))
    await screen.findByText('Staffing settings saved.')
    expect(server.store.workerLifecycle.readPolicy(workspace.id).enabled).toBe(false)
    cleanup()
    render(<StaffingSettings workspaceId={workspace.id} />)
    fireEvent.click(screen.getByText('Dynamic staffing and retired members'))
    await waitFor(
      () =>
        expect(screen.getByRole('spinbutton', { name: 'Maximum temporary members' })).toHaveValue(
          3
        ),
      { timeout: 15000 }
    )
    expect(screen.getByRole('checkbox', { name: 'Local fixture' })).toBeChecked()
  } finally {
    cleanup()
    await server.close()
  }
}, 60000)
