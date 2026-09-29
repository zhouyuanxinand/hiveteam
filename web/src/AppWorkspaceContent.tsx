import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import type { AgentInspection } from './activity/activity-attention-api.js'
import type { OrchestratorStartFailure } from './agent-start-error.js'
import type { OrchestratorStartResult, TerminalRunSummary } from './api.js'
import { DemoWorkspaceView } from './demo/DemoWorkspaceView.js'
import type { DemoReplaySnapshot } from './demo/demo-fixture.js'
import { useI18n } from './i18n.js'
import { isRemoteMode } from './remote/remote-permissions-api.js'
import { WorkspaceDetail } from './WorkspaceDetail.js'
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels.js'
import type { WorkerActions } from './worker/useWorkerActions.js'

type AppWorkspaceContentProps = {
  onOpenSkills?: (() => void) | undefined
  agentInspection?: AgentInspection | null | undefined
  activeId: string | undefined
  activeWorkspace: WorkspaceSummary | undefined
  bootstrapError: string | null
  demoMode: boolean
  demoReplay: DemoReplaySnapshot
  onDeleteWorkspace: (workspace: WorkspaceSummary) => Promise<void>
  onExitDemo: () => void
  onRequestAddWorkspace: () => void
  onShellRunClosed: (workspaceId: string, runId: string) => void
  onShellRunStarted: (workspaceId: string, run: TerminalRunSummary) => void
  onWorkersChanged?: ((workspaceId: string, workers: TeamListItem[]) => void) | undefined
  onTryDemo: () => void
  optimisticRunsByWorkspaceId: Record<string, TerminalRunSummary[]>
  orchestratorAutostartErrors: Record<string, OrchestratorStartFailure | null>
  orchestratorAutostartRunIds: Record<string, string | null>
  recordOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  terminalRuns: TerminalRunSummary[]
  workerActions: WorkerActions
  workers: TeamListItem[]
}

export const AppWorkspaceContent = ({
  onOpenSkills,
  agentInspection,
  activeId,
  activeWorkspace,
  bootstrapError,
  demoMode,
  demoReplay,
  onDeleteWorkspace,
  onExitDemo,
  onRequestAddWorkspace,
  onShellRunClosed,
  onShellRunStarted,
  onWorkersChanged,
  onTryDemo,
  optimisticRunsByWorkspaceId,
  orchestratorAutostartErrors,
  orchestratorAutostartRunIds,
  recordOrchestratorResult,
  terminalRuns,
  workerActions,
  workers,
}: AppWorkspaceContentProps) => {
  const { language } = useI18n()
  if (demoMode) return <DemoWorkspaceView onExit={onExitDemo} replay={demoReplay} />
  if (isRemoteMode() && !activeWorkspace)
    return (
      <div className="m-auto max-w-md p-6 text-center text-sm text-sec" role="status">
        {language === 'zh'
          ? '尚无可查看的工作区。请在本机打开远程设备面板，为此设备选择读取范围；授权后此页面会自动更新。'
          : 'No visible workspaces yet. On the local computer, open the remote-device panel and choose read access for this device. This page updates automatically.'}
      </div>
    )

  return (
    <>
      {workerActions.stopConfirmation}
      {activeId ? (
        <WorkspaceTerminalPanels
          key={`terminal-${activeId}`}
          optimisticRuns={optimisticRunsByWorkspaceId[activeId] ?? []}
          terminalRuns={terminalRuns}
          workspaceId={activeId}
        />
      ) : null}
      <WorkspaceDetail
        agentInspection={agentInspection}
        onOpenSkills={onOpenSkills}
        onCreateWorker={workerActions.createWorker}
        onDeleteWorker={workerActions.deleteWorker}
        onDeleteWorkspace={onDeleteWorkspace}
        onStartWorker={workerActions.startWorker}
        onStopWorker={workerActions.stopWorkerRun}
        onOrchestratorResult={recordOrchestratorResult}
        onRequestAddWorkspace={onRequestAddWorkspace}
        onShellRunClosed={onShellRunClosed}
        onShellRunStarted={onShellRunStarted}
        onWorkersChanged={onWorkersChanged}
        onTryDemo={onTryDemo}
        welcomeDisabledReason={bootstrapError ?? undefined}
        orchestratorAutostartError={
          activeId ? (orchestratorAutostartErrors[activeId] ?? null) : null
        }
        orchestratorAutostartRunId={
          activeId ? (orchestratorAutostartRunIds[activeId] ?? null) : null
        }
        terminalRuns={terminalRuns}
        workers={workers}
        workspace={activeWorkspace}
      />
    </>
  )
}
