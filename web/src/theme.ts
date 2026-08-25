export type UiTheme = 'dark' | 'light'

export const UI_THEME_STORAGE_KEY = 'hive.theme'
export const UI_THEME_CHANGE_EVENT = 'hive-theme-change'
export const DEFAULT_UI_THEME: UiTheme = 'dark'

const isUiTheme = (value: string | null): value is UiTheme => value === 'dark' || value === 'light'

export const readStoredUiTheme = (): UiTheme | null => {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(UI_THEME_STORAGE_KEY)
    return isUiTheme(stored) ? stored : null
  } catch {
    return null
  }
}

export const getInitialUiTheme = (): UiTheme => readStoredUiTheme() ?? DEFAULT_UI_THEME

export const persistUiTheme = (theme: UiTheme): void => {
  try {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, theme)
  } catch {
    // Theme switching still works for this session when storage is unavailable.
  }
}

/**
 * Applies the palette at the document boundary so the desktop and remote
 * entrypoints share one theme, including components rendered outside React.
 */
export const applyUiTheme = (theme: UiTheme): void => {
  if (typeof document === 'undefined') return

  document.documentElement.dataset.hiveTheme = theme
  document.documentElement.style.colorScheme = theme

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  meta?.setAttribute('content', theme === 'light' ? '#f7f8fa' : '#171717')

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<UiTheme>(UI_THEME_CHANGE_EVENT, { detail: theme }))
  }
}
