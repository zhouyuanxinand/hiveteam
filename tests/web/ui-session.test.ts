// @vitest-environment jsdom

import { afterEach, expect, test, vi } from 'vitest'

import { initializeUiSession } from '../../web/src/ui-session.js'

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

test('consumes the launch fragment before posting and shares the exchange across renders', async () => {
  window.history.replaceState(null, '', '/?view=team#hive_bootstrap=synthetic-bootstrap')
  const requests: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('?view=team')
    requests.push({ input, init })
    return new Response(JSON.stringify({ ok: true }))
  })
  await Promise.all([initializeUiSession(), initializeUiSession()])
  expect(requests).toHaveLength(1)
  expect(requests[0]?.init?.method).toBe('POST')
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    bootstrap_token: 'synthetic-bootstrap',
  })
  await initializeUiSession()
  expect(requests[1]?.init?.method).toBeUndefined()
})

test('expired runtime session instructs the user to reopen the trusted launcher', async () => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 403 }))
  await expect(initializeUiSession()).rejects.toThrow('Reopen Hive from its launcher')
})
