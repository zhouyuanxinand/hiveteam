import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
  }
})

describe('remote access routes', () => {
  test('keeps remote access disabled until a daemon token is linked', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const statusResponse = await fetch(`${server.baseUrl}/api/remote/status`, {
      headers: { cookie },
    })
    expect(statusResponse.status).toBe(200)
    await expect(statusResponse.json()).resolves.toMatchObject({
      connected: false,
      enabled: false,
      logged_in: false,
      status: 'disabled',
    })

    const enableResponse = await fetch(`${server.baseUrl}/api/remote/enabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ enabled: true }),
    })
    expect(enableResponse.status).toBe(409)
    await expect(enableResponse.json()).resolves.toEqual({
      error: 'Run hive remote login before enabling remote access',
    })
  })

  test('allows desktop pairing management but blocks the same trust-root actions remotely', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    server.store.settings.setAppState('remote_gateway_url', 'https://gateway.test')
    server.store.settings.setAppState('remote_daemon_token', 'daemon-token')
    server.store.settings.setAppState('remote_enabled', 'true')

    const ticketResponse = await fetch(`${server.baseUrl}/api/remote/pairings`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(ticketResponse.status).toBe(200)
    const ticket = (await ticketResponse.json()) as {
      code: string
      expires_at: number
      pairing_id: string
      qr: string
    }
    expect(ticket).toMatchObject({ pairing_id: expect.any(String), code: expect.any(String) })

    const remoteAttempt = await fetch(`${server.baseUrl}/api/remote/pairings`, {
      method: 'POST',
      headers: {
        'x-hive-remote-secret': server.store.getRemoteTunnelSecret(),
      },
    })
    expect(remoteAttempt.status).toBe(403)
    await expect(remoteAttempt.json()).resolves.toEqual({
      error: 'Device approval is desktop-only',
    })
  })
})
