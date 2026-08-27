import { lazy, Suspense, useEffect, useState } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import {
  getWorkspaceRecoverySettings,
  isWorkspaceShellRun,
  type OrchestratorStartResult,
  openModelPicker,
  renameWorker,
  setWorkspaceAutoResumeOnRestart,
  type TerminalRunSummary,
} from './api.js'
import { useI18n } from './i18n.js'
import { WorkspaceNotifications } from './notifications/WorkspaceNotifications.js'
import { TerminalBottomPanel } from './terminal/TerminalBottomPanel.js'
import { useTerminalPanelTabs } from './terminal/useTerminalPanelTabs.js'
import { findRunByAgentId } from './terminal/useTerminalRuns.js'
import { useWorkspaceShellLauncher } from './terminal/useWorkspaceShellLauncher.js'
import { useToast } from './ui/useToast.js'
import { usePaneSplit } from './usePaneSplit.js'
import { OrchestratorPane } from './worker/OrchestratorPane.js'
import { TeamScenarioDialog } from './worker/TeamScenarioDialog.js'
import { useOrchestratorPaneState } from './worker/useOrchestratorPaneState.js'
import type { WorkerActions } from './worker/useWorkerActions.js'
import { useWorkerComposer } from './worker/useWorkerComposer.js'
import { WelcomePane } from './worker/WelcomePane.js'
import { WorkersPane } from './worker/WorkersPane.js'

let addWorkerDialogModulePromise: Promise<typeof import('./worker/AddWorkerDialog.js')> | null =
  null
const loadAddWorkerDialog = () => {
  addWorkerDialogModulePromise ??= import('./worker/AddWorkerDialog.js')
  return addWorkerDialogModulePromise
}
const AddWorkerDialog = lazy(() =>
  loadAddWorkerDialog().then((module) => ({ default: module.AddWorkerDialog }))
)
const WorkerModal = lazy(() =>
  import('./worker/WorkerModal.js').then((module) => ({ default: module.WorkerModal }))
)

type WorkspaceDetailProps = {
  onCreateWorker: WorkerActions['createWorker']
  onDeleteWorker: (workerId: string) => Promise<void>
  onDeleteWorkspace: (workspace: WorkspaceSummary) => Promise<void>
  onStartWorker: (workerId: string) => Promise<{ error: string | null; runId: string | null }>
  onOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  onRequestAddWorkspace: () => void
  onShellRunClosed?: ((workspaceId: string, runId: string) => void) | undefined
  onShellRunStarted?: ((workspaceId: string, run: TerminalRunSummary) => void) | undefined
  onWorkersChanged?: ((workspaceId: string, workers: TeamListItem[]) => void) | undefined
  onTryDemo?: () => void
  welcomeDisabledReason?: string | undefined
  orchestratorAutostartError: string | null
  orchestratorAutostartRunId: string | null
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
  workspace: WorkspaceSummary | undefined
}

export const WorkspaceDetail = ({
  onCreateWorker,
  onDeleteWorker,
  onDeleteWorkspace,
  onStartWorker,
  onOrchestratorResult,
  onRequestAddWorkspace,
  onShellRunClosed,
  onShellRunStarted,
  onWorkersChanged,
  onTryDemo,
  welcomeDisabledReason,
  orchestratorAutostartError,
  orchestratorAutostartRunId,
  terminalRuns,
  workers,
  workspace,
}: WorkspaceDetailProps) => {
  const { t } = useI18n()
  const [activeWorkerId, setActiveWorkerId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [deleteWorkerError, setDeleteWorkerError] = useState<string | null>(null)
  const [startWorkerError, setStartWorkerError] = useState<string | null>(null)
  const [startingWorkerId, setStartingWorkerId] = useState<string | null>(null)
  const [terminalPanelHidden, setTerminalPanelHidden] = useState(false)
  const [autoResumeOnRestart, setAutoResumeOnRestart] = useState<boolean | undefined>(undefined)
  const [autoResumeBusy, setAutoResumeBusy] = useState(false)
  const [scenarioOpen, setScenarioOpen] = useState(false)
  const toast = useToast()
  const composer = useWorkerComposer({
    createWorker: onCreateWorker,
    open: composerOpen,
    workers,
  })
  useEffect(() => {
    if (!workspace) return
    // Start loading the composer once a workspace is visible. The Add button
    // stays responsive, while empty/welcome screens do not pay this cost.
    void loadAddWorkerDialog()
  }, [workspace])
  const orchestrator = useOrchestratorPaneState({
    workspaceId: workspace?.id ?? '',
    terminalRuns,
    autostartError: orchestratorAutostartError,
    suppressAutostartRunId: orchestratorAutostartRunId,
    onClearAutostartError: () => {
      if (workspace) onOrchestratorResult(workspace.id, { ok: true, error: null, run_id: null })
    },
    onAfterStart: (result) => {
      if (workspace) onOrchestratorResult(workspace.id, result)
    },
  })
  const split = usePaneSplit()
  const activeWorker: TeamListItem | null =
    workers.find((worker) => worker.id === activeWorkerId) ?? null
  useEffect(() => {
    if (activeWorkerId && !activeWorker) setActiveWorkerId(null)
  }, [activeWorkerId, activeWorker])
  const panelTabs = useTerminalPanelTabs({
    workspaceId: workspace?.id ?? '',
    workers,
    terminalRuns,
  })
  const shellPanelTabs = panelTabs.tabs.filter((tab) => tab.kind === 'shell')
  const shellRuns = workspace
    ? terminalRuns.filter((run) => isWorkspaceShellRun(run, workspace.id))
    : []
  const { closeShellTab, openShell, shellError, shellStarting, startNewShell } =
    useWorkspaceShellLauncher({
      onCloseFailed: (message) =>
        toast.show({ kind: 'error', message: t('shellTerminal.closeFailed', { message }) }),
      onShellRunClosed,
      onShellRunStarted,
      panelTabs,
      shellRuns,
      workspaceId: workspace?.id ?? null,
    })

  // Surface composer / delete errors as toasts instead of inline alert bands.
  useEffect(() => {
    if (composer.createWorkerError)
      toast.show({ kind: 'error', message: composer.createWorkerError })
  }, [composer.createWorkerError, toast])

  useEffect(() => {
    if (deleteWorkerError) toast.show({ kind: 'error', message: deleteWorkerError })
  }, [deleteWorkerError, toast])

  // Start failures no longer have a modal banner to display them — surface
  // via toast to keep parity with delete-error feedback.
  useEffect(() => {
    if (startWorkerError) toast.show({ kind: 'error', message: startWorkerError })
  }, [startWorkerError, toast])

  // Shell-start failures no longer have a dialog banner — surface via toast.
  useEffect(() => {
    if (shellError) toast.show({ kind: 'error', message: shellError })
  }, [shellError, toast])

  // B2: when the user switches workspace, clear local error state so we don't
  // surface a stale error from the previous workspace as a fresh toast.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect intentionally fires only on workspace switch
  useEffect(() => {
    setActiveWorkerId(null)
    setDeleteWorkerError(null)
    setStartWorkerError(null)
    setStartingWorkerId(null)
    setTerminalPanelHidden(false)
  }, [workspace?.id])

  useEffect(() => {
    let active = true
    setAutoResumeOnRestart(undefined)
    const workspaceId = workspace?.id
    if (!workspaceId) return () => {}
    void getWorkspaceRecoverySettings(workspaceId)
      .then((settings) => {
        if (active) setAutoResumeOnRestart(settings.autoResumeOnRestart)
      })
      .catch((error: unknown) => {
        if (active) {
          toast.show({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => {
      active = false
    }
  }, [toast, workspace?.id])

  if (!workspace) {
    const welcomeProps: {
      onAddWorkspace: () => void
      onTryDemo?: () => void
      disabledReason?: string
    } = { onAddWorkspace: onRequestAddWorkspace }
    if (onTryDemo) welcomeProps.onTryDemo = onTryDemo
    if (welcomeDisabledReason) welcomeProps.disabledReason = welcomeDisabledReason
    return <WelcomePane {...welcomeProps} />
  }

  const activeWorkerRun = activeWorker ? findRunByAgentId(terminalRuns, activeWorker.id) : undefined

  const handleDeleteWorker = (worker: TeamListItem) => {
    setDeleteWorkerError(null)
    void onDeleteWorker(worker.id)
      .then(() => setActiveWorkerId(null))
      .catch((error) => {
        setDeleteWorkerError(error instanceof Error ? error.message : String(error))
      })
  }

  const handleStartWorker = (worker: TeamListItem) => {
    setStartWorkerError(null)
    setStartingWorkerId(worker.id)
    void onStartWorker(worker.id)
      .then(({ error }) => {
        if (error) setStartWorkerError(error)
      })
      .catch((error) => {
        setStartWorkerError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setStartingWorkerId(null))
  }

  const handleRenameWorker = async (
    worker: TeamListItem,
    newName: string
  ): Promise<{ error: string | null }> => {
    try {
      await renameWorker(workspace.id, worker.id, newName)
      toast.show({
        kind: 'success',
        message: t('worker.renameSuccess', { name: newName }),
      })
      return { error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.show({ kind: 'error', message: t('worker.renameFailed', { message }) })
      return { error: message }
    }
  }

  const handleOpenModelPicker = (worker: TeamListItem) => {
    const run = findRunByAgentId(terminalRuns, worker.id)
    if (!run || !worker.commandPresetId) return
    void openModelPicker(run.run_id, worker.commandPresetId)
      .then(({ command }) => {
        toast.show({ kind: 'success', message: t('worker.modelPickerOpened', { command }) })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        toast.show({
          kind: 'error',
          message: t('worker.modelPickerFailed', { message }),
        })
      })
  }

  const orchWidth = `${(split.orchPct * 100).toFixed(2)}%`
  const openShellTerminal = () => {
    setTerminalPanelHidden(false)
    openShell()
  }
  const startNewShellFromPanel = () => {
    setTerminalPanelHidden(false)
    startNewShell()
  }

  return (
    <div
      className="workspace-detail flex min-h-0 min-w-0 flex-1 flex-col"
      style={{ background: 'var(--bg-2)' }}
    >
      <WorkspaceNotifications terminalRuns={terminalRuns} workers={workers} workspace={workspace} />
      <div ref={split.containerRef} className="workspace-pane-split relative flex min-h-0 flex-1">
        <div
          className="orchestrator-pane-shell flex min-w-[480px] shrink-0 flex-col"
          style={{ width: orchWidth }}
          data-testid="orchestrator-pane-shell"
        >
          <OrchestratorPane
            state={orchestrator.state}
            onStop={orchestrator.stop}
            onRemoveWorkspace={() => {
              void onDeleteWorkspace(workspace).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error)
                toast.show({ kind: 'error', message: `Delete failed: ${message}` })
              })
            }}
            onStart={orchestrator.start}
            onRestart={orchestrator.restart}
          />
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: <hr> can't host pointer/keyboard handlers and the visible accent line; aria role="separator" is the canonical resize-handle role */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workerPane.resize')}
          aria-valuenow={Math.round(split.orchPct * 100)}
          aria-valuemin={30}
          aria-valuemax={78}
          tabIndex={0}
          className="pane-splitter"
          style={{ left: `calc(${orchWidth} - 4px)` }}
          data-dragging={split.dragging || undefined}
          data-testid="pane-splitter"
          onPointerDown={split.beginDrag}
          onKeyDown={split.onKeyDown}
        />
        <div className="workers-pane-shell relative flex min-w-0 flex-1 flex-col">
          <WorkersPane
            autoResumeBusy={autoResumeBusy}
            autoResumeOnRestart={autoResumeOnRestart}
            onAddWorkerClick={() => setComposerOpen(true)}
            onAutoResumeChange={(enabled) => {
              if (!workspace) return
              const previous = autoResumeOnRestart
              setAutoResumeOnRestart(enabled)
              setAutoResumeBusy(true)
              void setWorkspaceAutoResumeOnRestart(workspace.id, enabled)
                .then((settings) => setAutoResumeOnRestart(settings.autoResumeOnRestart))
                .catch((error: unknown) => {
                  setAutoResumeOnRestart(previous)
                  toast.show({
                    kind: 'error',
                    message: error instanceof Error ? error.message : String(error),
                  })
                })
                .finally(() => setAutoResumeBusy(false))
            }}
            onDeleteWorker={handleDeleteWorker}
            onOpenShellTerminal={openShellTerminal}
            onOpenWorker={(worker) => setActiveWorkerId(worker.id)}
            onRenameWorker={handleRenameWorker}
            onScenarioClick={() => setScenarioOpen(true)}
            onStartWorker={handleStartWorker}
            startingWorkerId={startingWorkerId}
            terminalRuns={terminalRuns}
            workers={workers}
            workspaceId={workspace.id}
          />
          {terminalPanelHidden ? null : (
            <TerminalBottomPanel
              tabs={shellPanelTabs}
              activeId={panelTabs.activeId}
              onSelect={panelTabs.setActive}
              onClose={(tabId) => {
                if (tabId.startsWith('shell:')) {
                  closeShellTab(tabId.slice('shell:'.length))
                }
                panelTabs.closeTab(tabId)
              }}
              onClosePanel={() => setTerminalPanelHidden(true)}
              onNewShell={startNewShellFromPanel}
              newShellPending={shellStarting}
              onStartWorker={(workerId) => {
                const worker = workers.find((w) => w.id === workerId)
                if (worker) handleStartWorker(worker)
              }}
              startingWorkerId={startingWorkerId}
            />
          )}
        </div>
      </div>
      {activeWorker ? (
        <Suspense fallback={null}>
          <WorkerModal
            commandPresetId={activeWorker.commandPresetId}
            onClose={() => setActiveWorkerId(null)}
            onOpenModelPicker={handleOpenModelPicker}
            onStart={handleStartWorker}
            runId={activeWorkerRun?.run_id ?? null}
            startError={startWorkerError}
            starting={startingWorkerId === activeWorker.id}
            worker={activeWorker}
          />
        </Suspense>
      ) : null}
      <Suspense fallback={null}>
        <TeamScenarioDialog
          onClose={() => setScenarioOpen(false)}
          onWorkersChanged={(nextWorkers) => onWorkersChanged?.(workspace.id, nextWorkers)}
          open={scenarioOpen}
          workspaceId={workspace.id}
        />
      </Suspense>
      {composerOpen ? (
        <Suspense
          fallback={
            <div
              className="fixed inset-0 z-50 grid place-items-center bg-black/50"
              data-testid="add-worker-loading"
            >
              <div className="elev-2 rounded-lg border px-5 py-4 text-sm text-sec" role="status">
                Loading team member form…
              </div>
            </div>
          }
        >
          <AddWorkerDialog
            commandPresets={composer.commandPresets}
            commandPresetId={composer.commandPresetId}
            creating={composer.creating}
            customTemplates={composer.customTemplates}
            onApplyMarketplaceImport={composer.applyMarketplaceImport}
            onClose={() => setComposerOpen(false)}
            onDeleteTemplate={composer.deleteTemplate}
            onNameChange={composer.setWorkerName}
            onModelChange={composer.setModel}
            onPresetChange={composer.setCommandPresetId}
            onRandomName={composer.randomizeWorkerName}
            onRoleDescriptionChange={composer.setRoleDescription}
            onRoleDescriptionReset={composer.resetRoleDescription}
            onRoleChange={composer.setWorkerRole}
            onSaveAsTemplate={composer.saveAsTemplate}
            onSubmit={(event) => composer.submit(event, () => setComposerOpen(false))}
            onStartupCommandChange={composer.setStartupCommand}
            onTemplateChange={composer.selectTemplate}
            roleDescription={composer.roleDescription}
            roleDescriptionDefault={composer.roleDescriptionDefault}
            selectedTemplateId={composer.selectedTemplateId}
            model={composer.model}
            startupCommand={composer.startupCommand}
            templateBusy={composer.templateBusy}
            workerName={composer.workerName}
            workerRole={composer.workerRole}
          />
        </Suspense>
      ) : null}
    </div>
  )
}
