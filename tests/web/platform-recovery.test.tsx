// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { PlatformRecoveryView } from '../../src/shared/platform-recovery.js'
import { DEFAULT_RESOURCE_LIMITS } from '../../src/shared/resource-budget.js'
import type { ResourceStatus } from '../../src/shared/resource-status.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { PlatformRecoveryPanel } from '../../web/src/resources/PlatformRecoveryPanel.js'
import { ResourceStatusButton } from '../../web/src/resources/ResourceStatusButton.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'

const initial = (): PlatformRecoveryView => ({
  managed: true,
  supervision: {
    state: 'restarting',
    restart_count: 2,
    last_error: 'Runtime exited unexpectedly',
    children: [{ name: 'runtime', pid: null }],
  },
  auto_start: { supported: true, enabled: false, platform: 'win32' },
})
const resources: ResourceStatus = {
  limits: { ...DEFAULT_RESOURCE_LIMITS },
  occupancy: {
    global: 0,
    by_workspace: {},
    by_kind: { orchestrator: 0, worker: 0, verification: 0, workspace_shell: 0 },
  },
  reservations: [],
  queue: [],
  workspaces: [],
  occupants: [],
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
  delete (window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__
})

test('resources include current supervision details and keep startup unchecked until the OS update succeeds', async () => {
  const view = initial()
  let release: () => void = () => {}
  const saved = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (input === '/api/resources') return json(resources)
    if (init?.method === 'PUT') {
      await saved
      view.auto_start.enabled = JSON.parse(String(init.body)).enabled
    }
    return json(view)
  })
  render(<ResourceStatusButton />)
  fireEvent.click(screen.getByRole('button', { name: 'Runtime resources' }))
  const panel = await screen.findByRole('region', { name: 'Platform recovery' })
  expect(await within(panel).findByText('Supervision enabled')).toBeVisible()
  expect(within(panel).getByText('Restarting')).toBeVisible()
  expect(within(panel).getByText('2')).toBeVisible()
  expect(within(panel).getByRole('alert')).toHaveTextContent('Runtime exited unexpectedly')
  const toggle = within(panel).getByRole('switch', { name: 'Start HiveTeam when I sign in' })
  expect(toggle).not.toBeChecked()
  fireEvent.click(toggle)
  expect(toggle).toBeDisabled()
  expect(toggle).not.toBeChecked()
  expect(within(panel).getByRole('status')).toHaveTextContent('Saving sign-in startup')
  await act(async () => release())
  await waitFor(() => expect(toggle).toBeChecked())
  expect(toggle).toBeEnabled()
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).not.toBeChecked())
})

test('a failed OS update leaves the previous enabled setting visible and reports the error', async () => {
  const view = initial()
  view.managed = false
  view.supervision = null
  view.auto_start.enabled = true
  vi.stubGlobal('fetch', async (_: string, init?: RequestInit) =>
    init?.method === 'PUT'
      ? json({ error: 'Operating system denied registration' }, 409)
      : json(view)
  )
  render(<PlatformRecoveryPanel />)
  expect(await screen.findByText('Not supervised')).toBeVisible()
  const toggle = screen.getByRole('switch')
  expect(toggle).toBeChecked()
  fireEvent.click(toggle)
  expect(await screen.findByRole('alert')).toHaveTextContent('Operating system denied registration')
  expect(toggle).toBeChecked()
  expect(toggle).toBeEnabled()
})

test('Chinese recovery details disable login startup when the operating system does not support it', async () => {
  const view = initial()
  view.supervision = { state: 'failed', restart_count: 4, last_error: null, children: [] }
  view.auto_start = {
    supported: false,
    enabled: false,
    platform: 'linux',
  }
  vi.stubGlobal('fetch', async () => json(view))
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'zh')
  render(
    <I18nProvider>
      <PlatformRecoveryPanel />
    </I18nProvider>
  )
  expect(await screen.findByText('守护已启用')).toBeVisible()
  expect(screen.getByText('恢复失败')).toBeVisible()
  expect(screen.getByText('连续重试次数')).toBeVisible()
  expect(screen.getByRole('switch', { name: '登录系统时自动启动 HiveTeam' })).toBeDisabled()
  expect(screen.getByText('当前系统不支持登录自启动。')).toBeVisible()
})

test('an unavailable status does not expose an unchecked startup control as if it were real OS state', async () => {
  vi.stubGlobal('fetch', async () => json({ error: 'Platform status unavailable' }, 503))
  render(<PlatformRecoveryPanel />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading platform status')
  expect(await screen.findByRole('alert')).toHaveTextContent('Platform status unavailable')
  expect(screen.queryByRole('switch')).toBeNull()
})

test('remote mode exposes neither the resource entry nor recovery controls', () => {
  ;(window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__ = true
  render(
    <>
      <ResourceStatusButton />
      <PlatformRecoveryPanel />
    </>
  )
  expect(screen.queryByRole('button', { name: 'Runtime resources' })).toBeNull()
  expect(screen.queryByRole('region', { name: 'Platform recovery' })).toBeNull()
  expect(screen.queryByRole('switch')).toBeNull()
})

test('a failed OS status query hides startup controls until a subsequent poll confirms the setting', async () => {
  vi.useFakeTimers()
  let view = initial()
  view.supervision = null
  view.auto_start.enabled = true
  vi.stubGlobal('fetch', async () => json(view))
  await act(async () => {
    render(<PlatformRecoveryPanel />)
  })
  expect(screen.getByRole('switch')).toBeChecked()
  view = {
    ...view,
    auto_start: { ...view.auto_start, enabled: false, error: 'Scheduler unavailable' },
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
  expect(screen.queryByRole('switch')).toBeNull()
  expect(
    screen.getByText(
      'Sign-in startup status is unknown. Wait for a successful refresh before changing it.'
    )
  ).toBeVisible()
  expect(screen.getByRole('alert')).toHaveTextContent('Scheduler unavailable')
  view = { ...view, auto_start: { supported: true, enabled: true, platform: 'win32' } }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
  expect(screen.getByRole('switch')).toBeChecked()
  expect(screen.getByRole('switch')).toBeEnabled()
  expect(screen.queryByRole('alert')).toBeNull()
})
