// @vitest-environment jsdom

import { createServer } from 'node:http'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createVersionService, type VersionInfoPayload } from '../../src/server/version-service.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { Topbar } from '../../web/src/layout/Topbar.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'
import { NpmUpdateNotice } from '../../web/src/updates/NpmUpdateNotice.js'
import { listenOnFetchSafePort, startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const nativeFetch = globalThis.fetch
let closeRuntime: (() => Promise<void>) | undefined
let closeRegistry: (() => Promise<void>) | undefined
let latestVersion = '2.2.0'
let registryStatus = 200
let versionRequests = 0
let versionResponses: Array<{ status: number; info: VersionInfoPayload | null }> = []
let onVersionResponse: (() => void) | undefined
let registryGate: Promise<void> | null = null
let releaseRegistry: (() => void) | undefined
let onRegistryRequest: (() => void) | undefined
let versionSignals: Array<AbortSignal | null | undefined> = []
let clipboardDescriptor: PropertyDescriptor | undefined
let visibilityDescriptor: PropertyDescriptor | undefined

beforeEach(async () => {
  window.localStorage.clear()
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  latestVersion = '2.2.0'
  registryStatus = 200
  versionRequests = 0
  versionResponses = []
  onVersionResponse = undefined
  registryGate = null
  releaseRegistry = undefined
  onRegistryRequest = undefined
  versionSignals = []
  const registry = createServer(async (request, response) => {
    if (request.url !== '/hiveteam/latest') {
      response.writeHead(404).end()
      return
    }
    onRegistryRequest?.()
    onRegistryRequest = undefined
    if (registryGate) await registryGate
    response.writeHead(registryStatus, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ version: latestVersion }))
  })
  const registryPort = await listenOnFetchSafePort(registry)
  closeRegistry = () => new Promise<void>((resolve) => registry.close(() => resolve()))
  const runtime = await startTestServer({
    versionService: createVersionService({
      currentVersion: '2.2.0',
      registryUrl: `http://127.0.0.1:${registryPort}`,
      fetchImpl: nativeFetch,
      cacheTtlMs: 0,
    }),
  })
  closeRuntime = runtime.close
  const cookie = await getUiCookie(runtime.baseUrl, runtime.store)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(path, runtime.baseUrl)
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie)
    if (url.pathname === '/api/version/latest') {
      versionRequests += 1
      versionSignals.push(init?.signal)
    }
    const response = await nativeFetch(url, { ...init, headers })
    if (url.pathname === '/api/version/latest') {
      versionResponses.push({
        status: response.status,
        info: response.ok ? ((await response.clone().json()) as VersionInfoPayload) : null,
      })
      onVersionResponse?.()
      onVersionResponse = undefined
    }
    return response
  })
})

afterEach(async () => {
  cleanup()
  releaseRegistry?.()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor)
  else Reflect.deleteProperty(document, 'visibilityState')
  await closeRuntime?.()
  await closeRegistry?.()
  closeRuntime = undefined
  closeRegistry = undefined
})

describe('npm update notice with a real runtime and registry', () => {
  test('offers an upgrade for an old page even when the runtime already matches npm latest', async () => {
    const view = render(<Topbar hideActions version="2.1.19" />)
    const trigger = await screen.findByRole('button', { name: 'Upgrade to latest' })
    expect(screen.getByText('v2.1.19')).toBeInTheDocument()
    expect(versionResponses[0]?.info?.update_available).toBe(false)
    expect(versionResponses[0]?.info?.current_version).toBe('2.2.0')

    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog', { name: 'A newer HiveTeam version is available' })
    expect(panel).toHaveAttribute('aria-modal', 'false')
    expect(panel).toHaveTextContent('This page: v2.1.19 · Latest: v2.2.0')
    expect(panel).toHaveTextContent('npm install -g hiveteam@latest')
    expect(panel).toHaveTextContent('npx --yes hiveteam@latest')
    expect(panel).toHaveTextContent('stop HiveTeam first')
    expect(panel).toHaveTextContent('Refreshing alone does not upgrade the npm package')
    expect(panel).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()

    view.rerender(<Topbar hideActions version="2.2.0" />)
    expect(screen.getByText('v2.2.0')).toBeInTheDocument()
    expect(screen.queryByTestId('npm-update-notice')).toBeNull()
    view.rerender(<Topbar hideActions version="2.10.0" />)
    expect(screen.getByText('v2.10.0')).toBeInTheDocument()
    expect(screen.queryByTestId('npm-update-notice')).toBeNull()
  })

  test('copies both upgrade commands and shows confirmation in the panel', async () => {
    const copiedCommands: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copiedCommands.push(value)
        },
      },
    })
    render(<NpmUpdateNotice version="2.1.19" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to latest' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy npm install -g hiveteam@latest' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Command copied'))
    expect(copiedCommands).toEqual(['npm install -g hiveteam@latest'])
    fireEvent.click(screen.getByRole('button', { name: 'Copy npx --yes hiveteam@latest' }))
    await waitFor(() =>
      expect(copiedCommands).toEqual([
        'npm install -g hiveteam@latest',
        'npx --yes hiveteam@latest',
      ])
    )
    expect(screen.getByRole('status')).toHaveTextContent('Command copied')
    fireEvent.click(screen.getByRole('button', { name: 'Close upgrade instructions' }))
    expect(screen.queryByTestId('npm-update-panel')).toBeNull()
    expect(screen.getByTestId('npm-update-notice')).toHaveFocus()
  })

  test('keeps selectable instructions when clipboard access fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Clipboard permission denied')
        },
      },
    })
    render(<NpmUpdateNotice version="2.1.19" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to latest' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy npm install -g hiveteam@latest' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Select the command'))
    expect(screen.getByText('npm install -g hiveteam@latest')).toHaveProperty('tagName', 'CODE')
  })

  test('uses Chinese upgrade copy when the UI language is Chinese', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'zh')
    render(
      <I18nProvider>
        <NpmUpdateNotice version="2.1.19" />
      </I18nProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: '升级到最新版' }))
    const panel = screen.getByRole('dialog', { name: 'HiveTeam 有新版本' })
    expect(panel).toHaveTextContent('当前页面：v2.1.19 · 最新：v2.2.0')
    expect(panel).toHaveTextContent('先保存工作并停止 HiveTeam')
    expect(
      screen.getByRole('button', { name: '复制 npm install -g hiveteam@latest' })
    ).toBeInTheDocument()
  })

  test('checks while visible, discovers later releases, and stops polling after unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const initialResponse = new Promise<void>((resolve) => {
      onVersionResponse = resolve
    })
    const view = render(<NpmUpdateNotice version="2.2.0" />)
    await act(async () => {
      await initialResponse
    })
    expect(versionResponses[0]?.info?.latest_version).toBe('2.2.0')
    expect(screen.queryByTestId('npm-update-notice')).toBeNull()
    latestVersion = '2.3.0'
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      vi.advanceTimersByTime(15 * 60 * 1_000)
    })
    expect(versionRequests).toBe(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to latest' }))
    expect(screen.getByTestId('npm-update-panel')).toHaveTextContent('Latest: v2.3.0')
    latestVersion = '2.4.0'
    await act(async () => {
      vi.advanceTimersByTime(15 * 60 * 1_000)
    })
    await waitFor(() =>
      expect(screen.getByTestId('npm-update-panel')).toHaveTextContent('Latest: v2.4.0')
    )
    expect(versionRequests).toBe(3)
    view.unmount()
    await act(async () => {
      vi.advanceTimersByTime(30 * 60 * 1_000)
    })
    fireEvent(document, new Event('visibilitychange'))
    expect(versionRequests).toBe(3)
    expect(screen.queryByTestId('npm-update-notice')).toBeNull()
  })

  test('registry outages stay quiet and a foreground check recovers the notice', async () => {
    registryStatus = 503
    render(<NpmUpdateNotice version="2.1.19" />)
    await waitFor(() => expect(versionResponses).toHaveLength(1))
    expect(versionResponses[0]?.status).toBe(503)
    expect(screen.queryByTestId('npm-update-notice')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    registryStatus = 200
    fireEvent(document, new Event('visibilitychange'))
    expect(await screen.findByRole('button', { name: 'Upgrade to latest' })).toBeInTheDocument()
  })

  test('foreground events share the pending check and its result still reveals the upgrade', async () => {
    registryGate = new Promise<void>((resolve) => {
      releaseRegistry = resolve
    })
    const registryRequested = new Promise<void>((resolve) => {
      onRegistryRequest = resolve
    })
    render(<NpmUpdateNotice version="2.1.19" />)
    await registryRequested
    expect(screen.queryByTestId('npm-update-notice')).toBeNull()
    fireEvent(document, new Event('visibilitychange'))
    fireEvent(document, new Event('visibilitychange'))
    fireEvent(document, new Event('visibilitychange'))
    expect(versionRequests).toBe(1)
    releaseRegistry?.()
    expect(await screen.findByRole('button', { name: 'Upgrade to latest' })).toBeInTheDocument()
    expect(versionResponses[0]?.info?.latest_version).toBe('2.2.0')
  })

  test('unmount aborts a pending request without displaying an update afterwards', async () => {
    registryGate = new Promise<void>((resolve) => {
      releaseRegistry = resolve
    })
    const registryRequested = new Promise<void>((resolve) => {
      onRegistryRequest = resolve
    })
    const view = render(<NpmUpdateNotice version="2.1.19" />)
    await registryRequested
    expect(versionSignals[0]?.aborted).toBe(false)
    view.unmount()
    expect(versionSignals[0]?.aborted).toBe(true)
    releaseRegistry?.()
    await act(async () => {})
    expect(screen.queryByTestId('npm-update-notice')).toBeNull()
  })

  test('does not check in demo mode and can resume checks when real mode returns', async () => {
    const view = render(<Topbar hideActions version="2.1.19" updateCheckEnabled={false} />)
    expect(screen.getByRole('banner')).toHaveTextContent('HiveTeam')
    expect(screen.queryByTestId('npm-update-notice')).toBeNull()
    expect(versionRequests).toBe(0)
    view.rerender(<Topbar hideActions version="2.1.19" updateCheckEnabled />)
    expect(await screen.findByRole('button', { name: 'Upgrade to latest' })).toBeInTheDocument()
    view.rerender(<Topbar hideActions version="2.1.19" updateCheckEnabled={false} />)
    expect(screen.queryByTestId('npm-update-notice')).toBeNull()
  })
})
