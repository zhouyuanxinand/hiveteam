import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamMemoryDreamReview, TeamMemoryDreamRun } from '../shared/team-memory.js'
import type {
  AgentSummary,
  TeamListItem,
  WorkspaceLanguage,
  WorkspaceSummary,
} from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { DispatchRecord, ListDispatchesOptions } from './dispatch-ledger-store.js'
import type { GitWorkspaceService } from './git-workspace-service.js'
import { ConflictError, ForbiddenError } from './http-errors.js'
import type { RecoveryMessage } from './message-log-store.js'
import { sanitizePromptData, wrapUntrustedPromptData } from './prompt-safety.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import type { RemoteAuditStore } from './remote-audit-store.js'
import type { RemoteConfigSource } from './remote-config-keys.js'
import type { DeviceSessionProvider } from './remote-device-session.js'
import type { RemoteDeviceStore } from './remote-device-store.js'
import type { RemotePairing } from './remote-pairing.js'
import type { RemoteTunnel } from './remote-tunnel.js'
import { createRuntimeStoreExternalGoalMethods } from './runtime-store-external-goals.js'
import {
  type AutoResumeResult,
  createRuntimeStoreLifecycle,
  createRuntimeStoreServices,
} from './runtime-store-helpers.js'
import type { SettingsStore } from './settings-store.js'
import {
  createTeamMemoryDreamScheduler,
  type TeamMemoryDreamScheduler,
} from './team-memory-dream-scheduler.js'
import type { TeamMemoryDreamStore } from './team-memory-dream-store.js'
import {
  isWorkspaceMemoryDreamEnabled,
  isWorkspaceMemoryEnabled,
  readWorkspaceMemoryDreamLastScheduledAt,
  setWorkspaceMemoryDreamLastScheduledAt,
} from './team-memory-feature.js'
import type { TeamMemoryStore } from './team-memory-store.js'
import type {
  CancelTaskInput,
  DispatchTaskInput,
  ReportTaskInput,
  ReportTaskResult,
  StatusTaskInput,
} from './team-operations.js'
import type { TerminalRunSummary } from './terminal-input-profile.js'
import type { WorkflowRuntime } from './workflow-runtime.js'
import type { WorkerInput, WorkspaceRecord } from './workspace-store.js'

export interface LocalRetentionDiagnostics {
  databaseBytes: number | null
  dataDir: string | null
  records: Record<string, number>
  schemaVersion: number
  storage: 'local'
}

interface RuntimeStore {
  close: () => Promise<void>
  git: GitWorkspaceService
  createWorkspace: (path: string, name: string, language?: WorkspaceLanguage) => WorkspaceSummary
  deleteWorkspace: (workspaceId: string) => Promise<void>
  listWorkspaces: () => WorkspaceSummary[]
  addWorker: (workspaceId: string, input: WorkerInput) => AgentSummary
  deleteWorker: (workspaceId: string, workerId: string) => void
  renameWorker: (workspaceId: string, workerId: string, name: string) => AgentSummary
  setWorkerAvatar: (workspaceId: string, workerId: string, avatar: string | null) => AgentSummary
  recordUserInput: (workspaceId: string, orchestratorId: string, text: string) => void
  dispatchTask: (
    workspaceId: string,
    workerId: string,
    text: string,
    input?: DispatchTaskInput
  ) => Promise<DispatchRecord>
  dispatchTaskByWorkerName: (
    workspaceId: string,
    workerName: string,
    text: string,
    input?: DispatchTaskInput
  ) => Promise<DispatchRecord>
  reportTask: (workspaceId: string, workerId: string, input?: ReportTaskInput) => ReportTaskResult
  statusTask: (workspaceId: string, workerId: string, input?: StatusTaskInput) => ReportTaskResult
  cancelTask: (workspaceId: string, dispatchId: string, input: CancelTaskInput) => ReportTaskResult
  listDispatches: (workspaceId: string, options?: ListDispatchesOptions) => DispatchRecord[]
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  listWorkers: (workspaceId: string) => TeamListItem[]
  getLastPtyLineForAgent: (workspaceId: string, agentId: string) => string | null
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  getWorker: (workspaceId: string, workerId: string) => AgentSummary
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getWorkspaceRecoverySettings: (workspaceId: string) => { autoResumeOnRestart: boolean }
  getLocalRetentionDiagnostics: () => LocalRetentionDiagnostics
  getPtyOutputBus: () => PtyOutputBus
  listTerminalRuns: (workspaceId: string) => TerminalRunSummary[]
  closeWorkspaceShell: (workspaceId: string, runId: string) => boolean
  startWorkspaceShell: (workspaceId: string) => Promise<LiveAgentRun>
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => void
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => AgentLaunchConfigInput | undefined
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  autostartConfiguredAgents: (input: StartAgentOptions) => Promise<
    Array<{
      agent_id: string
      error: string | null
      ok: boolean
      run_id: string | null
      workspace_id: string
    }>
  >
  autoResumeInterruptedAgents: (input: StartAgentOptions) => Promise<AutoResumeResult[]>
  startWorkspaceWatch: (workspaceId: string) => Promise<void>
  setAutoResumeOnRestart: (workspaceId: string, enabled: boolean) => void
  getLiveRun: (runId: string) => LiveAgentRun
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => LiveAgentRun | undefined
  registerTasksListener: (listener: (workspaceId: string, content: string) => void) => () => void
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  peekAgentToken: (agentId: string) => string | undefined
  pauseTerminalRun: (runId: string) => void
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  resumeTerminalRun: (runId: string) => void
  settings: SettingsStore
  memory: TeamMemoryStore
  memoryDream: TeamMemoryDreamStore
  workflows: WorkflowRuntime
  requestMemoryDream: (workspaceId: string) => Promise<TeamMemoryDreamRun>
  requestMemoryDreamWorkerReview: (
    workspaceId: string,
    dreamId: string,
    workerId: string,
    hivePort: string
  ) => Promise<TeamMemoryDreamReview>
  cancelExternalGoal: ReturnType<typeof createRuntimeStoreExternalGoalMethods>['cancelExternalGoal']
  continueExternalGoal: ReturnType<
    typeof createRuntimeStoreExternalGoalMethods
  >['continueExternalGoal']
  inspectExternalGoalWorkspace: ReturnType<
    typeof createRuntimeStoreExternalGoalMethods
  >['inspectExternalGoalWorkspace']
  listExternalGoalWorkspaces: ReturnType<
    typeof createRuntimeStoreExternalGoalMethods
  >['listExternalGoalWorkspaces']
  reportExternalGoal: ReturnType<typeof createRuntimeStoreExternalGoalMethods>['reportExternalGoal']
  startExternalGoal: ReturnType<typeof createRuntimeStoreExternalGoalMethods>['startExternalGoal']
  waitExternalGoal: ReturnType<typeof createRuntimeStoreExternalGoalMethods>['waitExternalGoal']
  remote: {
    audit: RemoteAuditStore
    config: RemoteConfigSource
    devices: RemoteDeviceStore
    pairing: RemotePairing
    sessions: DeviceSessionProvider
    tunnel: RemoteTunnel | null
    setTunnel: (tunnel: RemoteTunnel | null) => void
  }
  writeRunInput: (runId: string, input: Buffer | string) => void
  getSupervisorToken: () => string
  getUiToken: () => string
  getRemoteTunnelSecret: () => string
  stopAgentRun: (runId: string) => void
  validateRemoteTunnelSecret: (secret: string | undefined) => boolean
  validateAgentToken: (agentId: string, token: string | undefined) => boolean
  validateSupervisorToken: (token: string | undefined) => boolean
  validateUiToken: (token: string | undefined) => boolean
}

interface RuntimeStoreOptions {
  dataDir?: string
  agentManager?: AgentManager
}

interface StartAgentOptions {
  autoResume?: boolean
  hivePort: string
}

export type { RuntimeStore }

export const createRuntimeStore = (options: RuntimeStoreOptions = {}): RuntimeStore => {
  const services = createRuntimeStoreServices(options)
  const externalGoals = createRuntimeStoreExternalGoalMethods(services)
  const buildDreamPrompt = (run: TeamMemoryDreamRun) =>
    [
      '[Hive system message: Team memory Dream review]',
      'Review the prepared memory consolidation below as the Workspace Orchestrator.',
      'This is a visible review request. Do not submit or alter memory outside the Hive UI workflow.',
      'Only the Workspace Orchestrator authority may submit the reviewed Dream.',
      wrapUntrustedPromptData('memory', JSON.stringify(run.suggestions), 8_000),
      'After reviewing, leave the Dream in review state until the user confirms submission.',
    ].join('\n\n')
  const deliverDream = async (run: TeamMemoryDreamRun) => {
    const orchestratorId = `${run.workspaceId}:orchestrator`
    const activeRun = services.agentRuntime.getActiveRunByAgentId(run.workspaceId, orchestratorId)
    if (!activeRun || run.executionStatus === 'requested') return run
    services.memoryDreamStore.markExecutionRequested(run.workspaceId, run.id, activeRun.runId)
    try {
      await services.agentRuntime.deliverSystemMessageToAgent(
        run.workspaceId,
        orchestratorId,
        buildDreamPrompt(run),
        { requireActiveRun: true }
      )
      return services.memoryDreamStore.get(run.workspaceId, run.id) ?? run
    } catch (error) {
      return (
        services.memoryDreamStore.markExecutionFailed(
          run.workspaceId,
          run.id,
          error instanceof Error ? error.message : String(error)
        ) ?? run
      )
    }
  }
  const deliverPendingDreams = async (workspaceId: string, agentId: string) => {
    if (agentId !== `${workspaceId}:orchestrator`) return
    for (const run of services.memoryDreamStore.listPendingExecution(workspaceId)) {
      await deliverDream(run)
    }
  }
  const lifecycle = createRuntimeStoreLifecycle(
    options.agentManager
      ? { agentManager: options.agentManager, onAgentStarted: deliverPendingDreams, services }
      : { onAgentStarted: deliverPendingDreams, services }
  )
  const stopTerminalRun = (runId: string) => {
    if (!services.shellRuntime.hasRun(runId)) {
      let liveRun: LiveAgentRun | null = null
      try {
        liveRun = services.agentRuntime.getLiveRun(runId)
      } catch {
        // Keep stop idempotent for a run that exited between the UI request
        // and this lookup. The lifecycle layer still performs the final stop.
      }
      if (liveRun) {
        for (const workspace of services.workspaceStore.listWorkspaces()) {
          const agent = services.workspaceStore
            .getWorkspaceSnapshot(workspace.id)
            .agents.find((candidate) => candidate.id === liveRun.agentId)
          if (!agent) continue
          if (agent.role !== 'orchestrator') {
            services.workspaceStore.markAgentManuallyStopped(workspace.id, agent.id)
          }
          break
        }
      }
    }
    lifecycle.stopTerminalRun(runId)
  }
  const pendingGitScans = new Set<Promise<void>>()
  let closePromise: Promise<void> | null = null
  let memoryDreamScheduler: TeamMemoryDreamScheduler | null = null
  const close = () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      // Workspace binding performs Git detection in the background so the API
      // remains fast. Await those processes before closing the database and
      // deleting test/workspace directories; otherwise Windows can keep the
      // workspace CWD locked for a short period after runtime shutdown.
      while (pendingGitScans.size > 0) {
        await Promise.all(Array.from(pendingGitScans))
      }
      await memoryDreamScheduler?.close()
      await lifecycle.close()
    })()
    return closePromise
  }
  const runDataMutation = (mutation: () => void) => {
    if (!services.db) {
      mutation()
      return
    }
    services.db.transaction(mutation)()
  }
  const getLocalRetentionDiagnostics = (): LocalRetentionDiagnostics => {
    const count = (table: string) => {
      const row = services.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count?: number
      }
      return Number(row.count ?? 0)
    }
    const versionRow = services.db
      .prepare('SELECT MAX(version) AS version FROM schema_version')
      .get() as { version?: number | null }
    let databaseBytes: number | null = null
    if (services.dataDir) {
      try {
        databaseBytes = statSync(join(services.dataDir, 'runtime.sqlite')).size
      } catch {
        databaseBytes = null
      }
    }
    return {
      databaseBytes,
      dataDir: services.dataDir,
      records: {
        dispatches: count('dispatches'),
        externalGoalEvents: count('external_goal_events'),
        externalGoalSessions: count('external_goal_sessions'),
        gitSnapshots: count('git_snapshots'),
        memoryEntries: count('memory_entries'),
        memoryDreamRuns: count('memory_dream_runs'),
        messages: count('messages'),
        workflows: count('workflow_runs'),
        workspaces: count('workspaces'),
      },
      schemaVersion: Number(versionRow.version ?? 0),
      storage: 'local',
    }
  }
  const requestMemoryDream = async (workspaceId: string) =>
    deliverDream(services.memoryDreamStore.create(workspaceId))
  memoryDreamScheduler = createTeamMemoryDreamScheduler({
    getScheduleState: (workspaceId) => {
      const lastScheduledAt = readWorkspaceMemoryDreamLastScheduledAt(
        services.settings,
        workspaceId
      )
      return {
        hasReviewDraft: services.memoryDreamStore
          .list(workspaceId, 50)
          .some((run) => run.status === 'review'),
        hasSourceMemory:
          services.memoryStore.list(workspaceId, { limit: 1, status: 'active' }).length > 0,
        hasUnreviewedActivity:
          services.messageLogStore.listMessagesForRecovery(workspaceId, lastScheduledAt ?? 0)
            .length > 0,
        lastScheduledAt,
      }
    },
    getWorkspaceSnapshot: (workspaceId) =>
      services.workspaceStore.getWorkspaceSnapshot(workspaceId),
    isEnabled: (workspaceId) =>
      isWorkspaceMemoryEnabled(services.settings, workspaceId) &&
      isWorkspaceMemoryDreamEnabled(services.settings, workspaceId),
    listWorkspaces: () => services.workspaceStore.listWorkspaces(),
    markScheduled: (workspaceId, timestamp) =>
      setWorkspaceMemoryDreamLastScheduledAt(services.settings, workspaceId, timestamp),
    runScheduled: requestMemoryDream,
  })
  memoryDreamScheduler.start()
  const requestMemoryDreamWorkerReview = async (
    workspaceId: string,
    dreamId: string,
    workerId: string,
    hivePort: string
  ) => {
    const dream = services.memoryDreamStore.get(workspaceId, dreamId)
    if (!dream) throw new ConflictError('Dream run not found')
    if (dream.status !== 'review') throw new ConflictError('Only a Dream in review can be reviewed')
    const worker = services.workspaceStore.getWorker(workspaceId, workerId)
    if (worker.role === 'orchestrator') {
      throw new ForbiddenError('The Orchestrator cannot be assigned a worker review')
    }
    const orchestratorId = `${workspaceId}:orchestrator`
    const orchestrator = services.workspaceStore.getAgent(workspaceId, orchestratorId)
    if (orchestrator.role !== 'orchestrator') {
      throw new ForbiddenError('Only the Workspace Orchestrator can request a review')
    }
    const task = [
      'Review this Team memory Dream as a supporting worker.',
      `Dream id: ${sanitizePromptData(dream.id, 100)}`,
      'Return findings in normal prose. If you recommend replacement suggestions, append a JSON object after DREAM_REVIEW_JSON.',
      'The JSON shape is {"suggestions":[{"body":"...","kind":"decision|fact|preference|pitfall|procedure_ref","scope":"workspace|user","source_memory_ids":[],"tags":[]}]}.',
      'Do not submit the Dream; only the Workspace Orchestrator can submit it.',
      wrapUntrustedPromptData('memory', JSON.stringify(dream.suggestions), 8_000),
    ].join('\n\n')
    const dispatch = await services.teamOps.dispatchTask(workspaceId, workerId, task, {
      fromAgentId: orchestratorId,
      hivePort,
    })
    const review = services.memoryDreamStore.recordReviewRequest(
      workspaceId,
      dreamId,
      workerId,
      dispatch.id
    )
    if (dispatch.status === 'failed') {
      return services.memoryDreamStore.markReviewFailed(workspaceId, dispatch.id) ?? review
    }
    if (dispatch.status === 'reported' && dispatch.reportText) {
      services.memoryDreamStore.recordWorkerReview(
        workspaceId,
        dispatch.id,
        dispatch.reportText,
        dispatch.artifacts
      )
    }
    return review
  }
  const reportTask = (workspaceId: string, workerId: string, input?: ReportTaskInput) => {
    const result = services.teamOps.reportTask(workspaceId, workerId, input)
    if (result.dispatch) {
      try {
        services.memoryDreamStore.recordWorkerReview(
          workspaceId,
          result.dispatch.id,
          result.dispatch.reportText ?? '',
          result.dispatch.artifacts
        )
        services.workflowRuntime.recordDispatchReport(workspaceId, result.dispatch)
      } catch (error) {
        console.error('[hive] post-report workflow bookkeeping failed', {
          error: error instanceof Error ? error.message : String(error),
          workspaceId,
        })
      }
    }
    return result
  }
  let remoteTunnel: RemoteTunnel | null = null
  return {
    close,
    git: services.git,
    createWorkspace: (path, name, language) => {
      const workspace = services.workspaceStore.createWorkspace(path, name, language)
      const gitScan = services.git
        .getStatus(workspace.id, workspace.path)
        .catch((error: unknown) => {
          if (String(error).toLowerCase().includes('database connection is not open')) return
          console.warn('[hive] Git repository detection failed while binding workspace', {
            error: error instanceof Error ? error.message : String(error),
            workspaceId: workspace.id,
          })
        })
        .then(() => undefined)
      pendingGitScans.add(gitScan)
      void gitScan.then(
        () => pendingGitScans.delete(gitScan),
        () => pendingGitScans.delete(gitScan)
      )
      void lifecycle.startWorkspaceWatch(workspace.id)
      return workspace
    },
    listWorkspaces: () => services.workspaceStore.listWorkspaces(),
    deleteWorkspace: async (workspaceId) => {
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
      await lifecycle.deleteWorkspaceShell(workspaceId)
      for (const agent of workspace.agents) {
        const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
        if (activeRun) {
          services.agentRuntime.stopAgentRun(activeRun.runId)
          await services.agentRuntime.waitForAgentRunExit?.(activeRun.runId)
        }
        services.agentRuntime.deleteAgentLaunchConfig(workspaceId, agent.id)
      }
      await services.tasksFileWatcher.stop(workspaceId)
      runDataMutation(() => {
        services.memoryStore.deleteWorkspaceEntries(workspaceId)
        services.memoryDreamStore.deleteWorkspace(workspaceId)
        services.externalGoalStore.deleteWorkspaceGoals(workspaceId)
        services.reportOutbox.deleteWorkspaceEntries(workspaceId)
        services.dispatchLedgerStore.deleteWorkspaceDispatches(workspaceId)
        services.git.deleteWorkspace(workspaceId)
        services.workspaceStore.deleteWorkspace(workspaceId)
      })
      if (services.settings.getAppState('active_workspace_id')?.value === workspaceId) {
        services.settings.setAppState('active_workspace_id', null)
      }
    },
    addWorker: (workspaceId, input) => services.workspaceStore.addWorker(workspaceId, input),
    renameWorker: (workspaceId, workerId, name) =>
      services.workspaceStore.renameWorker(workspaceId, workerId, name),
    setWorkerAvatar: (workspaceId, workerId, avatar) =>
      services.workspaceStore.setWorkerAvatar(workspaceId, workerId, avatar),
    deleteWorker: (workspaceId, workerId) => {
      const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
      if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
      services.agentRuntime.deleteAgentLaunchConfig(workspaceId, workerId)
      runDataMutation(() => {
        services.reportOutbox.deleteWorkerEntries(workspaceId, workerId)
        services.dispatchLedgerStore.deleteWorkerDispatches(workspaceId, workerId)
        services.workspaceStore.deleteWorker(workspaceId, workerId)
      })
    },
    recordUserInput: (workspaceId, orchestratorId, text) => {
      services.teamOps.recordUserInput(workspaceId, orchestratorId, text)
      services.gitTurnCoordinator.recordInput(workspaceId, orchestratorId, text)
    },
    cancelTask: services.teamOps.cancelTask,
    dispatchTask: services.teamOps.dispatchTask,
    dispatchTaskByWorkerName: services.teamOps.dispatchTaskByWorkerName,
    reportTask,
    statusTask: services.teamOps.statusTask,
    listDispatches: services.dispatchLedgerStore.listWorkspaceDispatches,
    getDispatch: services.dispatchLedgerStore.getDispatchById,
    listWorkers: (workspaceId) => {
      // `team list` is the Orchestrator's normal first call after a restart.
      // Use it as the durable report replay trigger.
      services.teamOps.drainReportOutbox(workspaceId)
      const pendingByWorker = new Map<string, number>()
      for (const dispatch of services.dispatchLedgerStore.listWorkspaceDispatches(workspaceId)) {
        if (
          dispatch.status === 'queued' ||
          dispatch.status === 'submitted' ||
          dispatch.status === 'failed'
        ) {
          pendingByWorker.set(
            dispatch.toAgentId,
            (pendingByWorker.get(dispatch.toAgentId) ?? 0) + 1
          )
        }
      }
      return services.workspaceStore.listWorkers(workspaceId).map((worker) => ({
        ...worker,
        pendingTaskCount: pendingByWorker.get(worker.id) ?? worker.pendingTaskCount,
      }))
    },
    getLastPtyLineForAgent: (workspaceId, agentId) =>
      services.workerOutputTracker?.getLastPtyLine(workspaceId, agentId) ?? null,
    getWorkspaceSnapshot: (workspaceId) =>
      services.workspaceStore.getWorkspaceSnapshot(workspaceId),
    getWorker: (workspaceId, workerId) => services.workspaceStore.getWorker(workspaceId, workerId),
    getAgent: (workspaceId, agentId) => services.workspaceStore.getAgent(workspaceId, agentId),
    getWorkspaceRecoverySettings: (workspaceId) =>
      services.workspaceStore.getWorkspaceRecoverySettings(workspaceId),
    getLocalRetentionDiagnostics,
    getPtyOutputBus: lifecycle.getPtyOutputBus,
    listTerminalRuns: lifecycle.listTerminalRuns,
    closeWorkspaceShell: lifecycle.closeWorkspaceShell,
    configureAgentLaunch: lifecycle.configureAgentLaunch,
    peekAgentLaunchConfig: lifecycle.peekAgentLaunchConfig,
    startAgent: lifecycle.startAgent,
    autostartConfiguredAgents: lifecycle.autostartConfiguredAgents,
    autoResumeInterruptedAgents: lifecycle.autoResumeInterruptedAgents,
    startWorkspaceWatch: lifecycle.startWorkspaceWatch,
    setAutoResumeOnRestart: (workspaceId, enabled) =>
      services.workspaceStore.setAutoResumeOnRestart(workspaceId, enabled),
    startWorkspaceShell: lifecycle.startWorkspaceShell,
    getLiveRun: lifecycle.getLiveRun,
    getActiveRunByAgentId: (workspaceId, agentId) =>
      services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId),
    registerTasksListener: lifecycle.registerTasksListener,
    listAgentRuns: (agentId) => services.agentRuntime.listAgentRuns(agentId),
    listMessagesForRecovery: (workspaceId, sinceMs) =>
      services.messageLogStore.listMessagesForRecovery(workspaceId, sinceMs),
    peekAgentToken: (agentId) => services.agentRuntime.peekAgentToken(agentId),
    pauseTerminalRun: lifecycle.pauseTerminalRun,
    resizeAgentRun: lifecycle.resizeTerminalRun,
    resumeTerminalRun: lifecycle.resumeTerminalRun,
    settings: services.settings,
    memory: services.memoryStore,
    memoryDream: services.memoryDreamStore,
    requestMemoryDream,
    requestMemoryDreamWorkerReview,
    workflows: services.workflowRuntime,
    ...externalGoals,
    remote: {
      audit: services.remoteAudit,
      config: services.remoteConfig,
      devices: services.remoteDevices,
      pairing: services.remotePairing,
      sessions: services.remoteSessions,
      get tunnel() {
        return remoteTunnel
      },
      setTunnel: (tunnel) => {
        remoteTunnel = tunnel
      },
    },
    writeRunInput: lifecycle.writeRunInput,
    getSupervisorToken: () => services.uiAuth.getSupervisorToken(),
    getUiToken: () => services.uiAuth.getToken(),
    getRemoteTunnelSecret: () => services.uiAuth.getRemoteTunnelSecret(),
    stopAgentRun: stopTerminalRun,
    validateRemoteTunnelSecret: (secret) => services.uiAuth.validateRemoteTunnelSecret(secret),
    validateAgentToken: (agentId, token) =>
      services.agentRuntime.validateAgentToken(agentId, token),
    validateSupervisorToken: (token) => services.uiAuth.validateSupervisorToken(token),
    validateUiToken: (token) =>
      services.uiAuth.validate(token) || services.uiAuth.validateRemoteTunnelSecret(token),
  }
}
