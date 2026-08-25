import { Brain, ListChecks, Workflow } from 'lucide-react'
import type { ReactNode } from 'react'

import { useI18n } from '../i18n.js'
import { NotificationSettingsButton } from '../notifications/NotificationSettingsButton.js'
import { RemoteAccessButton } from '../remote/RemoteAccessButton.js'
import { Tooltip } from '../ui/Tooltip.js'
import { APP_VERSION } from '../version.js'
import { LanguageToggle } from './LanguageToggle.js'
import { ThemeToggle } from './ThemeToggle.js'

type TopbarProps = {
  actions?: ReactNode
  hideActions?: boolean
  onToggleTaskGraph?: () => void
  onToggleMemory?: () => void
  onToggleWorkflows?: () => void
  openTaskCount?: number
  taskGraphOpen?: boolean
  memoryOpen?: boolean
  workflowsOpen?: boolean
  version?: string
}

export const Topbar = ({
  actions,
  hideActions = false,
  onToggleTaskGraph,
  onToggleMemory,
  onToggleWorkflows,
  openTaskCount = 0,
  taskGraphOpen = false,
  memoryOpen = false,
  workflowsOpen = false,
  version = APP_VERSION,
}: TopbarProps) => {
  const { t } = useI18n()
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
        <span className="topbar-brand-name font-semibold text-pri">HiveTeam</span>
        <span className="topbar-brand-version text-ter text-xs tabular-nums">v{version}</span>
      </div>
      <div className="topbar-spacer min-w-0 flex-1" />
      <div className="topbar-actions flex min-w-0 items-center gap-1">
        {hideActions ? null : (
          <>
            {actions}
            <RemoteAccessButton />
            {onToggleMemory ? (
              <Tooltip label={t('memory.title')}>
                <button
                  type="button"
                  onClick={onToggleMemory}
                  aria-pressed={memoryOpen}
                  aria-label={t('memory.title')}
                  className="topbar-knowledge-button"
                  data-active={memoryOpen ? 'true' : undefined}
                  data-testid="topbar-memory"
                >
                  <Brain size={13} aria-hidden />
                  <span>{t('memory.tab')}</span>
                </button>
              </Tooltip>
            ) : null}
            {onToggleWorkflows ? (
              <Tooltip label={t('workflows.title')}>
                <button
                  type="button"
                  onClick={onToggleWorkflows}
                  aria-pressed={workflowsOpen}
                  aria-label={t('workflows.title')}
                  className="topbar-knowledge-button"
                  data-active={workflowsOpen ? 'true' : undefined}
                  data-testid="topbar-workflows"
                >
                  <Workflow size={13} aria-hidden />
                  <span>{t('workflows.tab')}</span>
                </button>
              </Tooltip>
            ) : null}
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
          </>
        )}
        <ThemeToggle />
      </div>
    </header>
  )
}
