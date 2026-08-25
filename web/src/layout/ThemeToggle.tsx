import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useI18n } from '../i18n.js'
import { applyUiTheme, getInitialUiTheme, persistUiTheme, type UiTheme } from '../theme.js'
import { Tooltip } from '../ui/Tooltip.js'

export const ThemeToggle = () => {
  const { t } = useI18n()
  const [theme, setTheme] = useState<UiTheme>(getInitialUiTheme)
  const nextTheme: UiTheme = theme === 'dark' ? 'light' : 'dark'
  const label = t(nextTheme === 'light' ? 'theme.switchToLight' : 'theme.switchToDark')

  useEffect(() => {
    applyUiTheme(theme)
  }, [theme])

  const toggleTheme = () => {
    setTheme(nextTheme)
    persistUiTheme(nextTheme)
  }

  return (
    <Tooltip label={label}>
      <span>
        <button
          type="button"
          aria-label={label}
          aria-pressed={theme === 'light'}
          className="topbar-theme-toggle flex h-7 items-center gap-1 rounded border px-2 text-xs font-medium text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          data-testid="topbar-theme-toggle"
          onClick={toggleTheme}
          style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
        >
          {theme === 'dark' ? <Sun size={13} aria-hidden /> : <Moon size={13} aria-hidden />}
          <span className="topbar-theme-label">{label}</span>
        </button>
      </span>
    </Tooltip>
  )
}
