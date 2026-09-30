// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { RemoteAccessButton } from '../../web/src/remote/RemoteAccessButton.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const nativeFetch = globalThis.fetch
let closeServer: (() => Promise<void>) | undefined

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await closeServer?.()
  closeServer = undefined
})

const openLoginPanel = async (gatewayUrl?: string) => {
  const server = await startTestServer()
  closeServer = server.close
  if (gatewayUrl) server.store.settings.internalAppState.set('remote_gateway_url', gatewayUrl)
  const cookie = await getUiCookie(server.baseUrl)
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie)
    return nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
  })
  let copiedText: string | null = null
  vi.stubGlobal('navigator', {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: 'en-US',
    clipboard: {
      writeText: async (text: string) => {
        copiedText = text
      },
    },
  })
  render(<RemoteAccessButton />)
  fireEvent.click(screen.getByTestId('topbar-remote'))
  await screen.findByText('Remote access is not signed in.')
  return { server, clipboard: () => copiedText }
}

test('first remote login explains self hosting and copies an explicit gateway command', async () => {
  const { server, clipboard } = await openLoginPanel()
  const command = 'hive remote login --gateway https://your-gateway.example'
  expect(screen.getByText(command)).toBeInTheDocument()
  expect(screen.getByText(/Deploy your own HiveTeam gateway/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
  await waitFor(() => expect(clipboard()).toBe(command))
  expect(server.store.remote.config.getGatewayUrl()).toBeNull()
  expect(server.store.remote.config.isEnabled()).toBe(false)
}, 15_000)

test('remote login reuses an existing gateway without replacing its saved address', async () => {
  const gatewayUrl = 'https://existing-gateway.invalid'
  const { server, clipboard } = await openLoginPanel(gatewayUrl)
  expect(screen.getByText('hive remote login')).toBeInTheDocument()
  expect(screen.queryByText(/Deploy your own HiveTeam gateway/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
  await waitFor(() => expect(clipboard()).toBe('hive remote login'))
  expect(server.store.remote.config.getGatewayUrl()).toBe(gatewayUrl)
  expect(server.store.remote.config.isEnabled()).toBe(false)
}, 15_000)
