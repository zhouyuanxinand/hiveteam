import type { ReactNode } from 'react'

import { useI18n } from '../i18n.js'
import { Topbar } from './Topbar.js'
import {
  useWorkspaceSidebarResize,
  WORKSPACE_SIDEBAR_MAX,
  WORKSPACE_SIDEBAR_MIN,
} from './useWorkspaceSidebarResize.js'

type MainLayoutProps = {
  children: ReactNode
  hideTopbarActions?: boolean
  onToggleTaskGraph?: (() => void) | undefined
  onToggleActivity?: (() => void) | undefined
  onToggleMemory?: (() => void) | undefined
  onToggleGit?: (() => void) | undefined
  onToggleWorkflows?: (() => void) | undefined
  openTaskCount?: number
  sidebar: ReactNode
  taskGraphOpen?: boolean
  activityOpen?: boolean
  memoryOpen?: boolean
  gitOpen?: boolean
  workflowsOpen?: boolean
  topbarActions?: ReactNode
}

export const MainLayout = ({
  children,
  hideTopbarActions = false,
  onToggleTaskGraph,
  onToggleActivity,
  onToggleMemory,
  onToggleGit,
  onToggleWorkflows,
  openTaskCount = 0,
  sidebar,
  taskGraphOpen = false,
  activityOpen = false,
  memoryOpen = false,
  gitOpen = false,
  workflowsOpen = false,
  topbarActions,
}: MainLayoutProps) => {
  const { t } = useI18n()
  const sidebarResize = useWorkspaceSidebarResize()

  return (
    <div
      className="main-layout flex h-screen w-full flex-col overflow-hidden"
      style={{ background: 'var(--bg-0)', color: 'var(--text-primary)' }}
    >
      <Topbar
        actions={topbarActions}
        hideActions={hideTopbarActions}
        onToggleTaskGraph={onToggleTaskGraph}
        onToggleActivity={onToggleActivity}
        onToggleMemory={onToggleMemory}
        onToggleGit={onToggleGit}
        onToggleWorkflows={onToggleWorkflows}
        openTaskCount={openTaskCount}
        taskGraphOpen={taskGraphOpen}
        activityOpen={activityOpen}
        memoryOpen={memoryOpen}
        gitOpen={gitOpen}
        workflowsOpen={workflowsOpen}
      />
      <div className="main-layout-body flex min-h-0 flex-1">
        <aside
          aria-label={t('layout.sidebarAria')}
          className="workspace-sidebar relative flex shrink-0 flex-col"
          data-resizing={sidebarResize.resizing ? 'true' : 'false'}
          style={{
            background: 'var(--bg-0)',
            boxShadow: 'inset -1px 0 0 var(--border)',
            width: `${sidebarResize.width}px`,
          }}
        >
          {sidebar}
          <hr
            aria-label={t('layout.sidebarResizeAria')}
            aria-orientation="vertical"
            aria-valuemin={WORKSPACE_SIDEBAR_MIN}
            aria-valuemax={WORKSPACE_SIDEBAR_MAX}
            aria-valuenow={Math.round(sidebarResize.width)}
            tabIndex={0}
            className="workspace-sidebar-resizer"
            data-resizing={sidebarResize.resizing ? 'true' : 'false'}
            onMouseDown={sidebarResize.beginResize}
            onKeyDown={sidebarResize.onResizeKeyDown}
          />
        </aside>
        <section className="main-content relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {children}
        </section>
      </div>
    </div>
  )
}
