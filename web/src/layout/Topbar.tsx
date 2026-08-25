import { ListChecks } from 'lucide-react'
import type { ReactNode } from 'react'

import type { VersionInfo } from '../api.js'
import { useI18n } from '../i18n.js'
import { NotificationSettingsButton } from '../notifications/NotificationSettingsButton.js'
import { RemoteAccessButton } from '../remote/RemoteAccessButton.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useVersionInfo } from '../useVersionInfo.js'
import { APP_VERSION } from '../version.js'
import { LanguageToggle } from './LanguageToggle.js'

type TopbarProps = {
  actions?: ReactNode
  hideActions?: boolean
  onToggleTaskGraph?: () => void
  openTaskCount?: number
  taskGraphOpen?: boolean
  version?: string
  versionInfo?: VersionInfo
}

export const Topbar = ({
  actions,
  hideActions = false,
  onToggleTaskGraph,
  openTaskCount = 0,
  taskGraphOpen = false,
  version = APP_VERSION,
  versionInfo: providedVersionInfo,
}: TopbarProps) => {
  const { t } = useI18n()
  const versionInfo = useVersionInfo(providedVersionInfo)
  const updateInfo =
    versionInfo?.updateAvailable && versionInfo.latestVersion !== version ? versionInfo : null
  const hasOpenTasks = openTaskCount > 0
  const taskGraphTooltip = taskGraphOpen
    ? t('topbar.hideTodo')
    : hasOpenTasks
      ? t('topbar.todoOpen', { count: openTaskCount })
      : t('topbar.showTodo')
  return (
    <header
      className="topbar flex h-11 shrink-0 items-center px-4"
      style={{
        background: 'var(--bg-0)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div className="topbar-brand flex min-w-0 items-center gap-2">
        <img
          src="/logo.png"
          alt=""
          aria-hidden
          className="h-5 w-5 rounded-md"
          data-testid="topbar-logo"
        />
        <span className="topbar-brand-name font-semibold text-pri">Hive</span>
        <span className="topbar-brand-version text-ter text-xs tabular-nums">v{version}</span>
        {updateInfo ? (
          <div
            className="topbar-update flex items-center gap-2 text-xs"
            data-testid="topbar-update-badge"
          >
            <span
              className="rounded border px-2 py-0.5 font-medium"
              style={{
                background: 'color-mix(in oklab, var(--accent) 10%, transparent)',
                borderColor: 'color-mix(in oklab, var(--accent) 30%, transparent)',
                color: 'var(--accent)',
              }}
            >
              {t('topbar.updateAvailable')}
            </span>
            <span className="text-ter">
              v{version} → v{updateInfo.latestVersion}
            </span>
            <code className="mono text-ter">{updateInfo.installHint}</code>
          </div>
        ) : null}
      </div>
      <div className="topbar-spacer min-w-0 flex-1" />
      {hideActions ? null : (
        <div className="topbar-actions flex min-w-0 items-center gap-1">
          {actions}
          <RemoteAccessButton />
          {onToggleTaskGraph ? (
            <Tooltip label={taskGraphTooltip}>
              <button
                type="button"
                onClick={onToggleTaskGraph}
                aria-pressed={taskGraphOpen}
                aria-label={taskGraphTooltip}
                data-has-tasks={hasOpenTasks ? 'true' : undefined}
                className="flex h-7 cursor-pointer items-center gap-1 rounded border px-2 text-xs font-medium text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                data-testid="topbar-blueprint"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
              >
                <ListChecks size={13} className={hasOpenTasks ? 'text-accent' : undefined} />
                <span>{t('topbar.todo')}</span>
              </button>
            </Tooltip>
          ) : null}
          <LanguageToggle />
          <NotificationSettingsButton />
        </div>
      )}
    </header>
  )
}
