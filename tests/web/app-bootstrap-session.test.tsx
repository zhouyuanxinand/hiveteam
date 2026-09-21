// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'

let originalLocation: Location

beforeEach(() => {
  originalLocation = window.location
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test.each([
  401, 403,
])('session status %s is shown as sign-in required instead of an offline runtime or loading workspaces', async (status) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL) =>
      new Response(JSON.stringify(input === '/api/version' ? { version: '2.1.19' } : {}), {
        status: input === '/api/version' ? 200 : status,
      })
  )

  render(<App />)

  const page = await screen.findByTestId('ui-session-required-page')
  expect(page).toHaveTextContent('Sign in to HiveTeam again')
  expect(page).toHaveTextContent('launcher')
  expect(screen.queryByTestId('runtime-offline-page')).toBeNull()
  expect(
    within(screen.getByRole('navigation', { name: 'Workspaces' })).queryByText('Loading…')
  ).toBeNull()
})

test('a network failure still shows runtime recovery instead of requesting sign-in', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('Failed to fetch')
  })
  render(<App />)
  expect(await screen.findByTestId('runtime-offline-page')).toHaveTextContent(
    'HiveTeam runtime is not running'
  )
  expect(screen.queryByTestId('ui-session-required-page')).toBeNull()
})

test('session retry waits for authentication before reloading and the restored session loads workspace data', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let authenticated = false
  const sessionMethods: string[] = []
  const reload = vi.fn()
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...originalLocation, reload },
  })
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === '/api/ui/session') {
      sessionMethods.push(init?.method ?? 'GET')
      return new Response('{}', { status: authenticated ? 200 : 403 })
    }
    if (input === '/api/version') return new Response(JSON.stringify({ version: '2.1.19' }))
    if (input === '/api/workspaces') return new Response('[]')
    if (input === '/api/settings/app-state/active_workspace_id') {
      return new Response(JSON.stringify({ value: null }))
    }
    return new Response('{}', { status: 403 })
  })
  const first = render(<App />)
  const retry = await screen.findByRole('button', { name: 'Check sign-in' })
  fireEvent.click(retry)
  await waitFor(() => expect(retry).not.toBeDisabled())
  expect(reload).not.toHaveBeenCalled()
  expect(screen.getByTestId('ui-session-required-page')).toBeVisible()

  authenticated = true
  fireEvent.click(retry)
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  expect(sessionMethods).toEqual(['GET', 'GET', 'GET'])

  first.unmount()
  render(<App />)
  await waitFor(() =>
    expect(
      within(screen.getByRole('navigation', { name: 'Workspaces' })).getByText('No Workspaces')
    ).toBeVisible()
  )
  expect(screen.queryByTestId('ui-session-required-page')).toBeNull()
  expect(screen.queryByTestId('runtime-offline-page')).toBeNull()
})
