import { lazy, Suspense } from 'react'

import type { TeamListItem } from '../../src/shared/types.js'
import type { KnowledgeTab } from './knowledge/WorkspaceKnowledgeDrawer.js'
import type { useTasksFile } from './tasks/useTasksFile.js'
import { WorkspaceTaskDrawer } from './tasks/WorkspaceTaskDrawer.js'
import type { WorkspaceCreateInput } from './workspace/workspace-create-input.js'

type TasksFileApi = ReturnType<typeof useTasksFile>

const AddWorkspaceDialog = lazy(() =>
  import('./workspace/AddWorkspaceDialog.js').then((module) => ({
    default: module.AddWorkspaceDialog,
  }))
)
const FirstRunWizard = lazy(() =>
  import('./wizard/FirstRunWizard.js').then((module) => ({ default: module.FirstRunWizard }))
)
const WorkspaceKnowledgeDrawer = lazy(() =>
  import('./knowledge/WorkspaceKnowledgeDrawer.js').then((module) => ({
    default: module.WorkspaceKnowledgeDrawer,
  }))
)
const WorkspaceGitDrawer = lazy(() =>
  import('./git/WorkspaceGitDrawer.js').then((module) => ({
    default: module.WorkspaceGitDrawer,
  }))
)
const ActivityCenterDrawer = lazy(() =>
  import('./activity/ActivityCenterDrawer.js').then((module) => ({
    default: module.ActivityCenterDrawer,
  }))
)

type AppOverlaysProps = {
  addDialogTrigger: number
  onAddWorkspace: () => void
  onCloseTaskGraph: () => void
  onCloseWizard: (shouldMarkSeen?: boolean) => void
  onCloseKnowledge: () => void
  onCloseGit: () => void
  onCloseActivity: () => void
  onCreateWorkspace: (input: WorkspaceCreateInput) => Promise<unknown> | undefined
  onTryDemo: () => void
  taskGraphOpen: boolean
  knowledgeTab: KnowledgeTab | null
  gitOpen: boolean
  activityOpen: boolean
  tasksFile: TasksFileApi
  wizardOpen: boolean
  workspacePath: string | null
  workspaceId: string | null
  /** Workspace's active worker roster — feeds the §6.6.2 chip resolution. */
  workers?: readonly TeamListItem[]
  /** Cross-pane jump on chip click (§6.6.6). */
  onSelectOwner?: (workerName: string) => void
  /** §3.5.2 transport disconnect flag passed through unchanged. */
  connectionStale?: boolean
}

export const AppOverlays = ({
  addDialogTrigger,
  onAddWorkspace,
  onCloseTaskGraph,
  onCloseWizard,
  onCloseKnowledge,
  onCloseGit,
  onCloseActivity,
  onCreateWorkspace,
  onTryDemo,
  taskGraphOpen,
  knowledgeTab,
  gitOpen,
  activityOpen,
  tasksFile,
  wizardOpen,
  workspacePath,
  workspaceId,
  workers,
  onSelectOwner,
  connectionStale,
}: AppOverlaysProps) => (
  <>
    {workspacePath ? (
      /* Dormant Task Graph/Blueprint surface. App passes `open=false` while
         TASK_GRAPH_PRIMARY_ENTRY_ENABLED is disabled; keep it wired so older
         `.hive/tasks.md` workspaces and future reactivation have a tested path. */
      <WorkspaceTaskDrawer
        open={taskGraphOpen}
        tasksFile={tasksFile}
        onClose={onCloseTaskGraph}
        workspacePath={workspacePath}
        {...(workers ? { workers } : {})}
        {...(onSelectOwner ? { onSelectOwner } : {})}
        {...(connectionStale !== undefined ? { connectionStale } : {})}
      />
    ) : null}
    {workspaceId && knowledgeTab ? (
      <Suspense fallback={null}>
        <WorkspaceKnowledgeDrawer
          initialTab={knowledgeTab}
          onClose={onCloseKnowledge}
          open
          workspaceId={workspaceId}
        />
      </Suspense>
    ) : null}
    {workspaceId && gitOpen ? (
      <Suspense fallback={null}>
        <WorkspaceGitDrawer onClose={onCloseGit} open workspaceId={workspaceId} />
      </Suspense>
    ) : null}
    {workspaceId && activityOpen ? (
      <Suspense fallback={null}>
        <ActivityCenterDrawer onClose={onCloseActivity} open workspaceId={workspaceId} />
      </Suspense>
    ) : null}
    {addDialogTrigger > 0 ? (
      <Suspense fallback={null}>
        <AddWorkspaceDialog
          onClose={() => {}}
          onCreate={onCreateWorkspace}
          trigger={addDialogTrigger}
        />
      </Suspense>
    ) : null}
    {wizardOpen ? (
      <Suspense fallback={null}>
        <FirstRunWizard
          open={wizardOpen}
          onClose={onCloseWizard}
          onAddWorkspace={onAddWorkspace}
          onTryDemo={onTryDemo}
        />
      </Suspense>
    ) : null}
  </>
)
