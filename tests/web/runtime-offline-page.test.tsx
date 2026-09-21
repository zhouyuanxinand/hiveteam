// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { RuntimeOfflinePage } from '../../web/src/pwa/RuntimeOfflinePage.js'

// window.location.reload is not configurable in jsdom's default implementation,
// so we replace the entire location object with a writable surrogate just for
// this test file. The original is restored in afterEach to keep other tests
// running in the same worker isolated.
let originalLocation: Location
let reloadSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  originalLocation = window.location
  reloadSpy = vi.fn()
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...originalLocation, reload: reloadSpy },
  })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  })
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const stubFetch = (impl: () => Promise<Response>) => {
  const fetchFn = vi.fn(impl)
  vi.stubGlobal('fetch', fetchFn)
  return fetchFn
}

const okResponse = () => Promise.resolve({ ok: true } as Response)
const failResponse = () => Promise.resolve({ ok: false } as Response)
const rejectingFetch = () => Promise.reject(new Error('connection refused'))

describe('RuntimeOfflinePage', () => {
  test.each([
    'poll',
    'retry',
  ])('a pending session %s cannot reload after leaving the recovery page', async (source) => {
    vi.useFakeTimers()
    let completeProbe!: (response: Response) => void
    const response = new Promise<Response>((resolve) => {
      completeProbe = resolve
    })
    stubFetch(() => response)
    const { unmount } = render(<RuntimeOfflinePage sessionRequired />)
    await act(async () => {
      if (source === 'poll') await vi.advanceTimersByTimeAsync(3000)
      else fireEvent.click(screen.getByTestId('runtime-offline-retry'))
    })
    unmount()
    await act(async () => {
      completeProbe(new Response('{}'))
      await response
    })
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  test('session recovery polls authorization and reloads only after the launcher restores it', async () => {
    vi.useFakeTimers()
    let authenticated = false
    const requestedUrls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrls.push(String(input))
      expect(init?.method ?? 'GET').toBe('GET')
      return new Response('{}', { status: authenticated ? 200 : 403 })
    })
    render(<RuntimeOfflinePage sessionRequired />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    expect(requestedUrls).toEqual(['/api/ui/session', '/api/ui/session'])
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('ui-session-required-page')).toHaveTextContent('launcher')

    authenticated = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(requestedUrls).toEqual(['/api/ui/session', '/api/ui/session', '/api/ui/session'])
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  test('renders the offline title, body, retry button, and auto-reconnect hint', () => {
    stubFetch(failResponse)
    render(<RuntimeOfflinePage />)
    expect(screen.getByTestId('runtime-offline-page')).toBeTruthy()
    expect(screen.getByTestId('runtime-offline-retry')).toBeTruthy()
    // Body and auto-reconnect strings are i18n-driven; assert they're present
    // by content match rather than testid (no testid on body copy).
    const root = screen.getByTestId('runtime-offline-page')
    expect(root.textContent ?? '').toMatch(/HiveTeam runtime/i)
    expect(root.textContent ?? '').toMatch(/auto-reconnect/i)
  })

  test('clicking Retry probes /api/version and reloads when the runtime is back', async () => {
    const fetchFn = stubFetch(okResponse)
    render(<RuntimeOfflinePage />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-offline-retry'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/version',
      expect.objectContaining({ credentials: 'include' })
    )
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  test('clicking Retry does NOT reload when the daemon is still offline', async () => {
    stubFetch(failResponse)
    render(<RuntimeOfflinePage />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-offline-retry'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(reloadSpy).not.toHaveBeenCalled()
  })

  test('rejected fetch from Retry does not crash and does not reload', async () => {
    stubFetch(rejectingFetch)
    render(<RuntimeOfflinePage />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-offline-retry'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(reloadSpy).not.toHaveBeenCalled()
  })

  test('auto-reconnect probes every 3s and reloads on the first successful response', async () => {
    vi.useFakeTimers()
    let attemptCount = 0
    const fetchFn = stubFetch(() => {
      attemptCount += 1
      return attemptCount >= 2 ? okResponse() : failResponse()
    })

    render(<RuntimeOfflinePage />)
    expect(fetchFn).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(reloadSpy).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  test('auto-reconnect interval is cleared on unmount', async () => {
    vi.useFakeTimers()
    const fetchFn = stubFetch(failResponse)
    const { unmount } = render(<RuntimeOfflinePage />)
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('Try Demo button renders when onTryDemo is provided and invokes the callback', () => {
    stubFetch(failResponse)
    const onTryDemo = vi.fn()
    render(<RuntimeOfflinePage onTryDemo={onTryDemo} />)
    const button = screen.getByTestId('runtime-offline-try-demo')
    fireEvent.click(button)
    expect(onTryDemo).toHaveBeenCalledTimes(1)
    // The other affordances must remain — Try Demo is additive, not a swap.
    expect(screen.getByTestId('runtime-offline-retry')).toBeTruthy()
  })

  test('Try Demo button is absent when onTryDemo is not provided', () => {
    stubFetch(failResponse)
    render(<RuntimeOfflinePage />)
    expect(screen.queryByTestId('runtime-offline-try-demo')).toBeNull()
  })
})
