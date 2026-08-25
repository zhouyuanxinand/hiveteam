// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { I18nProvider } from '../../web/src/i18n.js'
import { ThemeToggle } from '../../web/src/layout/ThemeToggle.js'
import { applyUiTheme, DEFAULT_UI_THEME, UI_THEME_STORAGE_KEY } from '../../web/src/theme.js'

beforeEach(() => {
  window.localStorage.clear()
  delete document.documentElement.dataset.hiveTheme
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  delete document.documentElement.dataset.hiveTheme
})

describe('ThemeToggle', () => {
  test('defaults to dark mode and persists a light-mode switch', () => {
    render(
      <I18nProvider>
        <ThemeToggle />
      </I18nProvider>
    )

    const toggle = screen.getByTestId('topbar-theme-toggle')
    expect(DEFAULT_UI_THEME).toBe('dark')
    expect(document.documentElement.dataset.hiveTheme).toBe('dark')
    expect(toggle).toHaveAttribute('aria-label', 'Switch to light mode')

    fireEvent.click(toggle)

    expect(document.documentElement.dataset.hiveTheme).toBe('light')
    expect(window.localStorage.getItem(UI_THEME_STORAGE_KEY)).toBe('light')
    expect(toggle).toHaveAttribute('aria-label', 'Switch to dark mode')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  test('applies a stored light preference on mount', () => {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, 'light')

    render(
      <I18nProvider>
        <ThemeToggle />
      </I18nProvider>
    )

    expect(document.documentElement.dataset.hiveTheme).toBe('light')
    expect(screen.getByTestId('topbar-theme-toggle')).toHaveAttribute(
      'aria-label',
      'Switch to dark mode'
    )
  })

  test('applyUiTheme updates the document without requiring a theme-color meta tag', () => {
    applyUiTheme('light')
    expect(document.documentElement.dataset.hiveTheme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })
})
