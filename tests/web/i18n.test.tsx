// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { AppProviders } from '../../web/src/AppProviders.js'
import { Topbar } from '../../web/src/layout/Topbar.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'
import { WelcomePane } from '../../web/src/worker/WelcomePane.js'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('UI language', () => {
  test('uses the persisted language without rendering a topbar language switcher', () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'zh')
    render(
      <AppProviders>
        <Topbar version="0.6.0-alpha.5" />
        <WelcomePane onAddWorkspace={() => {}} />
      </AppProviders>
    )

    expect(screen.getByText('欢迎使用 HiveTeam')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /添加第一个 Workspace/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /切换语言/ })).not.toBeInTheDocument()
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('zh')
  })
})
