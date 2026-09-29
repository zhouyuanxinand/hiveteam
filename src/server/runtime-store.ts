import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamMemoryDreamReview, TeamMemoryDreamRun } from '../shared/team-memory.js'
import type {
  AgentSummary,
  TeamListItem,
  WorkspaceLanguage,
  WorkspaceSummary,
} from '../shared/types.js'
import {
  type ActivityAttentionQuery,
  createActivityAttentionQuery,
} from './activity-attention-query.js'
import { createAgentConversationReader } from './agent-conversation-reader.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { type ClarificationRuntime, createClarificationRuntime } from './clarification-runtime.js'
import { type CliReadinessRuntime, createCliReadiness } from './cli-readiness.js'
import { type CodeReviewRuntime, createCodeReviewRuntime } from './code-review-runtime.js'
import {
  type CollaborationStatsQuery,
  createCollaborationStatsQuery,
} from './collaboration-stats-query.js'
import { createDataBackup } from './data-backup.js'
import { createDataRetention, type DataRetention } from './data-retention.js'
import { createDeliveryQueueStore, type DeliveryQueueStore } from './delivery-queue-store.js'
import {
  createDispatchIntegrationRuntime,
  type DispatchIntegrationRuntime,
} from './dispatch-integration-runtime.js'
import type { DispatchRecord, ListDispatchesOptions } from './dispatch-ledger-store.js'
import type { GitWorkspaceService } from './git-workspace-service.js'
import type { GitHubClient } from './github-pull-requests.js'
import { ConflictError, HttpError } from './http-errors.js'
import {
  createIntegrationCandidateRuntime,
  type IntegrationCandidateRuntime,
} from './integration-candidate-runtime.js'
import type { RecoveryMessage } from './message-log-store.js'
import { createNativeSessionControl, type NativeSessionControl } from './native-session-control.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { createPullRequestRuntime, type PullRequestRuntime } from './pull-request-runtime.js'
import { createRecoveryIndex, type RecoveryIndex } from './recovery-index.js'
import type { RemoteAuditStore } from './remote-audit-store.js'
import type { RemoteConfigSource } from './remote-config-keys.js'
import type { DeviceSessionProvider } from './remote-device-session.js'
import type { RemoteDeviceStore } from './remote-device-store.js'
import type { RemotePairing } from './remote-pairing.js'
import type { RemotePermissionStore } from './remote-permission-store.js'
import type { RemoteTunnel } from './remote-tunnel.js'
import { createRuntimeStoreExternalGoalMethods } from './runtime-store-external-goals.js'
import {
  type AutoResumeResult,
  createRuntimeStoreLifecycle,
  createRuntimeStoreServices,
  type RuntimeStoreServices,
} from './runtime-store-helpers.js'
import { getCodexHome } from './session-capture-codex.js'
import type { SettingsStore } from './settings-store.js'
import { createTeamMemoryDreamRuntime } from './team-memory-dream-runtime.js'
import type { TeamMemoryDreamStore } from './team-memory-dream-store.js'
import type { TeamMemoryStore } from './team-memory-store.js'
import type {
  CancelTaskInput,
  DispatchTaskInput,
  ReportTaskInput,
  ReportTaskResult,
  StatusTaskInput,
} from './team-operations.js'
import { createTeamReviewRuntime, type TeamReviewRuntime } from './team-review-runtime.js'
import type { TerminalRunSummary } from './terminal-input-profile.js'
import { createVerificationRuntime, type VerificationRuntime } from './verification-runtime.js'
import { createWorkerBranchRuntime, type WorkerBranchRuntime } from './worker-branch-runtime.js'
import {
  createWorkerLifecycleRuntime,
  type WorkerLifecycleRuntime,
} from './worker-lifecycle-runtime.js'
import { assertWorkerAvailable } from './worker-lifecycle-store.js'
import type { WorkerWorktreeRuntime } from './worker-worktree-runtime.js'
import { createWorkflowEvidenceReader } from './workflow-evidence.js'
import type { WorkflowRuntime } from './workflow-runtime.js'
import {
  createWorkspaceDeliveryQuery,
  type WorkspaceDeliveryQuery,
} from './workspace-delivery-query.js'
import { createWorkspaceOnboarding, type WorkspaceOnboarding } from './workspace-onboarding.js'
import { createWorkspaceReview, type WorkspaceReview } from './workspace-review.js'
import {
  createWorkspaceSkillManager,
  type WorkspaceSkillManager,
} from './workspace-skill-manager.js'
import type { WorkerInput, WorkspaceRecord } from './workspace-store.js'
import {
  createWorktreeResourceRuntime,
  type WorktreeResourceRuntime,
} from './worktree-resource-runtime.js'

export interface LocalRetentionDiagnostics {
  databaseBytes: number | null
  dataDir: string | null
  records: Record<string, number>
  schemaVersion: number
  storage: 'local'
}

interface RuntimeStore {
  collaborationStats: CollaborationStatsQuery
  attention: ActivityAttentionQuery
  clarifications: ClarificationRuntime
  teamReviews: TeamReviewRuntime
  workerLifecycle: WorkerLifecycleRuntime
  cliReadiness: CliReadinessRuntime
  onboarding: WorkspaceOnboarding
  deliveryHistory: WorkspaceDeliveryQuery
  recoveryIndex: RecoveryIndex
  dataRetention: DataRetention
  createBackup: (output: string, nativeIds?: string[]) => ReturnType<typeof createDataBackup>
  nativeSessions: NativeSessionControl
  dispatchDelivery: import('./team-delivery-runtime.js').TeamDeliveryRuntime
  dispatchMessages: import('./dispatch-message-runtime.js').DispatchMessageRuntime
  resources: RuntimeStoreServices['resources']
  resourceQueue: RuntimeStoreServices['resourceQueue']
  cancelPendingAgentStart: (workspaceId: string, agentId: string) => void
  readAgentConversation: (
    workspaceId: string,
    agentId: string,
    runId?: string
  ) => Promise<import('../shared/agent-conversation.js').AgentConversation>
  verifications: VerificationRuntime
  codeReviews: CodeReviewRuntime
  executionPolicies: RuntimeStoreServices['executionPolicies']
  worktrees: WorkerWorktreeRuntime
  integrations: DispatchIntegrationRuntime
  candidates: IntegrationCandidateRuntime
  pullRequests: PullRequestRuntime
  deliveryQueue: DeliveryQueueStore
  branches: WorkerBranchRuntime
  worktreeResources: WorktreeResourceRuntime
  getDispatchWorkspacePath: (workspaceId: string, dispatchId: string) => string
  close: () => Promise<void>
  git: GitWorkspaceService
  review: WorkspaceReview
  createWorkspace: (path: string, name: string, language?: WorkspaceLanguage) => WorkspaceSummary
  deleteWorkspace: (workspaceId: string) => Promise<void>
  listWorkspaces: () => WorkspaceSummary[]
  addWorker: (workspaceId: string, input: WorkerInput) => AgentSummary
  addWorkers: (
    workspaceId: string,
    inputs: WorkerInput[],
    launchConfig?: AgentLaunchConfigInput
  ) => AgentSummary[]
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
  acceptDispatchReport: (
    workspaceId: string,
    dispatchId: string,
    reportRevision: number
  ) => DispatchRecord
  sendDispatchFeedback: (workspaceId: string, dispatchId: string, text: string) => DispatchRecord
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
  getRunInputSequence: (runId: string) => number
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
  memoryDreamGeneration: RuntimeStoreServices['memoryDreamGeneration']
  skills: WorkspaceSkillManager
  workflows: WorkflowRuntime
  requestMemoryDream: (workspaceId: string) => Promise<TeamMemoryDreamRun>
  requestMemoryDreamGeneration: (
    workspaceId: string,
    retry?: boolean
  ) => Promise<TeamMemoryDreamRun | null>
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
    permissions: RemotePermissionStore
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
  createUiBootstrap: () => string
  exchangeUiBootstrap: (token: string) => string
  getRemoteTunnelSecret: () => string
  stopAgentRun: (runId: string) => void
  validateRemoteTunnelSecret: (secret: string | undefined) => boolean
  validateAgentToken: (agentId: string, token: string | undefined) => boolean
  validateSupervisorToken: (token: string | undefined) => boolean
  validateUiToken: (token: string | undefined) => boolean
}

interface RuntimeStoreOptions {
  github?: GitHubClient
  dataDir?: string
  agentManager?: AgentManager
  skillHomePath?: string
}

interface StartAgentOptions {
  autoResume?: boolean
  hivePort: string
}

export type { RuntimeStore }

export const createRuntimeStore = (options: RuntimeStoreOptions = {}): RuntimeStore => {
  const services = createRuntimeStoreServices(options)
  const review = createWorkspaceReview({
    db: services.db,
    getWorkspacePath: (id) => services.workspaceStore.getWorkspaceSnapshot(id).summary.path,
    assertRecipient: (id, agentId) => {
      if (!services.workspaceStore.hasAgent(id, agentId))
        throw new HttpError(404, 'Recipient not found in this workspace')
    },
    isActive: (id, agentId) => !!services.agentRuntime.getActiveRunByAgentId(id, agentId),
    deliver: (id, text, agentId) =>
      services.agentRuntime.deliverSystemMessageToAgent(id, agentId, text, {
        requireActiveRun: true,
      }),
  })
  const getDispatchWorkspacePath = (workspaceId: string, dispatchId: string) => {
    const dispatch = services.dispatchLedgerStore.getDispatchById(workspaceId, dispatchId)
    if (!dispatch) throw new ConflictError('Dispatch not found')
    return services.worktrees.path(
      services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
      dispatch.toAgentId
    )
  }
  const verifications = createVerificationRuntime({
    db: services.db,
    dataDir: services.dataDir,
    resources: services.resources,
    resourceQueue: services.resourceQueue,
    getWorkspacePath: getDispatchWorkspacePath,
    isIsolated: (workspaceId, dispatchId) => {
      const dispatch = services.dispatchLedgerStore.getDispatchById(workspaceId, dispatchId)
      return !!dispatch && !!services.worktrees.get(workspaceId, dispatch.toAgentId)
    },
    assertWorkspaceWritable: services.worktrees.assertIdle,
    getDispatch: services.dispatchLedgerStore.getDispatchById,
    acceptReport: services.dispatchLedgerStore.acceptReport,
    onAccepted: (id, dispatch) => {
      services.workflowRuntime.recordDispatchReport(id, dispatch)
    },
    onChanged: services.workflowRuntime.evidenceChanged,
  })
  const codeReviews = createCodeReviewRuntime({
    db: services.db,
    getDispatch: services.dispatchLedgerStore.getDispatchById,
    source: (workspaceId, dispatch) => {
      const tree = services.worktrees.get(workspaceId, dispatch.toAgentId)
      return {
        sourcePath: getDispatchWorkspacePath(workspaceId, dispatch.id),
        targetPath: services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path,
        ...(tree ? { targetBranch: tree.targetBranch } : {}),
      }
    },
    assertReviewer: services.executionPolicies.assertReadOnlyReviewer,
    onChanged: services.workflowRuntime.evidenceChanged,
    withOperation: (workspaceId, operation) =>
      services.worktrees.exclusive(workspaceId, () =>
        services.git.withWorkspaceOperation(workspaceId, operation)
      ),
  })
  services.workflowRuntime.setEvidenceReader(
    createWorkflowEvidenceReader(codeReviews, verifications)
  )
  const integrations = createDispatchIntegrationRuntime({
    db: services.db,
    worktrees: services.worktrees,
    workspaceStore: services.workspaceStore,
    agentRuntime: services.agentRuntime,
    git: services.git,
    verifications,
    getDispatch: services.dispatchLedgerStore.getDispatchById,
  })
  const candidates = createIntegrationCandidateRuntime({
    db: services.db,
    dataDir: services.dataDir,
    resources: services.resources,
    resourceQueue: services.resourceQueue,
    reviews: codeReviews,
    verifications,
    worktrees: services.worktrees,
    workspaceStore: services.workspaceStore,
    agentRuntime: services.agentRuntime,
    git: services.git,
    getDispatch: services.dispatchLedgerStore.getDispatchById,
  })
  const pullRequests = createPullRequestRuntime({
    db: services.db,
    worktrees: services.worktrees,
    workspaceStore: services.workspaceStore,
    agentRuntime: services.agentRuntime,
    git: services.git,
    verifications,
    getDispatch: services.dispatchLedgerStore.getDispatchById,
    ...(options.github ? { github: options.github } : {}),
  })
  const deliveryQueue = createDeliveryQueueStore(
    services.db,
    services.dispatchLedgerStore.getDispatchById
  )
  const branches = createWorkerBranchRuntime({
    db: services.db,
    worktrees: services.worktrees,
    workspaceStore: services.workspaceStore,
    agentRuntime: services.agentRuntime,
    git: services.git,
    verifications,
  })
  const worktreeResources = createWorktreeResourceRuntime({
    db: services.db,
    dataDir: services.dataDir,
    worktrees: services.worktrees,
    agentRuntime: services.agentRuntime,
  })
  const skillPackResolver = services.skillPackResolver
  const readConversation = createAgentConversationReader()
  const skills = createWorkspaceSkillManager({
    getCommandPresetId: (workspaceId, agentId) => {
      const config = services.agentRuntime.peekAgentLaunchConfig(workspaceId, agentId)
      if (!config || config.presetAugmentationDisabled) return null
      if (config.commandPresetId) return config.commandPresetId
      const implicit = services.settings.getCommandPreset(config.command)
      return implicit?.command === config.command ? implicit.id : null
    },
    getActiveRunStartedAt: (workspaceId, agentId) =>
      services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId)?.startedAt ?? null,
    getWorkspace: services.workspaceStore.getWorkspaceSnapshot,
    ...(options.skillHomePath ? { homePath: options.skillHomePath } : {}),
    ...(skillPackResolver ? { packResolver: skillPackResolver } : {}),
    changeStore: services.skillPackChangeStore,
    releaseStore: services.skillPackReleaseStore,
    snapshotStore: services.skillSnapshotStore,
    teamSkillRuntime: services.teamSkillRuntime,
  })
  const externalGoals = createRuntimeStoreExternalGoalMethods(services)
  const memoryDreamRuntime = createTeamMemoryDreamRuntime(services)
  const lifecycle = createRuntimeStoreLifecycle(
    options.agentManager
      ? {
          agentManager: options.agentManager,
          onAgentStarted: memoryDreamRuntime.onAgentStarted,
          services,
        }
      : { onAgentStarted: memoryDreamRuntime.onAgentStarted, services }
  )
  const workerLifecycle = createWorkerLifecycleRuntime(services, lifecycle)
  const clarifications = createClarificationRuntime(services, workerLifecycle)
  const teamReviews = createTeamReviewRuntime(services, workerLifecycle, codeReviews)
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
          services.workspaceStore.markAgentManuallyStopped(workspace.id, agent.id)
          services.resourceQueue.cancelAgent(workspace.id, agent.id)
          services.agentRuntime.cancelPendingStart(workspace.id, agent.id)
          break
        }
      }
    }
    lifecycle.stopTerminalRun(runId)
  }
  const pendingGitScans = new Set<Promise<void>>()
  let closePromise: Promise<void> | null = null
  const close = () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      const closeMemoryDream = memoryDreamRuntime.close()
      const closeClarifications = clarifications.close()
      const closeTeamReviews = teamReviews.close()
      const closeWorkerLifecycle = workerLifecycle.close()
      lifecycle.stopAutoResume()
      services.agentRuntime.cancelAllPendingStarts()
      const closeWorkflows = services.workflowRuntime.close()
      const closeResourceQueue = services.resourceQueue.close()
      review.close()
      // Stop new dispatches immediately and drain any task that already began.
      // A dispatch captures its Git baseline asynchronously; closing SQLite
      // before that promise settles used to make the failure-recovery write run
      // against a closed database.
      const closeTeamOperations = services.teamOps.close()
      const closeVerifications = verifications.close()
      const closeWorktrees = services.worktrees.close()
      // Workspace binding performs Git detection in the background so the API
      // remains fast. Await those processes before closing the database and
      // deleting test/workspace directories; otherwise Windows can keep the
      // workspace CWD locked for a short period after runtime shutdown.
      while (pendingGitScans.size > 0) {
        await Promise.all(Array.from(pendingGitScans))
      }
      await closeClarifications
      await closeTeamReviews
      await closeWorkerLifecycle
      await closeTeamOperations
      await closeWorkflows
      await closeResourceQueue
      await closeVerifications
      await closeWorktrees
      await closeMemoryDream
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
        skillSnapshots: count('skill_snapshots'),
        skillChangePlans: count('skill_change_plans'),
        skillChangeAttempts: count('skill_change_attempts'),
        skillPlacements: count('skill_placements'),
        dispatchSkillActivations: count('dispatch_skill_activations'),
        skillPackReleases: count('skill_pack_releases'),
        workspaces: count('workspaces'),
      },
      schemaVersion: Number(versionRow.version ?? 0),
      storage: 'local',
    }
  }
  const reportTask = (workspaceId: string, workerId: string, input?: ReportTaskInput) => {
    services.worktrees.assertIdle(workspaceId)
    const result = services.teamOps.reportTask(workspaceId, workerId, input)
    if (result.dispatch && !result.duplicate) {
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
    clarifications,
    teamReviews,
    workerLifecycle,
    cliReadiness: createCliReadiness({
      policies: services.executionPolicies,
      resources: services.resources,
      dataDir: services.dataDir,
      getConfig: services.agentRuntime.peekAgentLaunchConfig,
      getCwd: (workspaceId, agentId) => {
        if (!services.workspaceStore.hasAgent(workspaceId, agentId))
          throw new HttpError(404, 'Member not found in this workspace')
        return (
          services.worktrees.get(workspaceId, agentId)?.checkoutPath ??
          services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
        )
      },
    }),
    nativeSessions: createNativeSessionControl({
      sessions: services.agentSessionStore.native,
      policies: services.executionPolicies,
      resources: services.resources,
      getConfig: services.agentRuntime.peekAgentLaunchConfig,
      getCwd: (workspaceId, agentId) => {
        if (
          !services.workspaceStore.listWorkspaces().some((item) => item.id === workspaceId) ||
          !services.workspaceStore.hasAgent(workspaceId, agentId)
        )
          throw new HttpError(404, 'Member not found in this workspace')
        return (
          services.worktrees.get(workspaceId, agentId)?.checkoutPath ??
          services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
        )
      },
    }),
    dispatchDelivery: services.dispatchDelivery,
    dispatchMessages: services.dispatchMessages,
    executionPolicies: services.executionPolicies,
    resources: services.resources,
    resourceQueue: services.resourceQueue,
    cancelPendingAgentStart(workspaceId, agentId) {
      services.workspaceStore.markAgentManuallyStopped(workspaceId, agentId)
      services.resourceQueue.cancelAgent(workspaceId, agentId)
      services.agentRuntime.cancelPendingStart(workspaceId, agentId)
    },
    close,
    review,
    codeReviews,
    verifications,
    worktrees: services.worktrees,
    integrations,
    candidates,
    pullRequests,
    deliveryQueue,
    branches,
    worktreeResources,
    async readAgentConversation(workspaceId, agentId, runId) {
      if (!services.workspaceStore.hasAgent(workspaceId, agentId))
        throw new HttpError(404, 'Agent not found in workspace')
      if (runId !== undefined) {
        if (!services.agentRuntime.listAgentRuns(agentId).some((run) => run.runId === runId))
          throw new HttpError(404, 'Run not found for agent')
        const binding = services.agentRuntime.getRunSessionContext(workspaceId, agentId, runId)
        if (!binding)
          return { run_id: runId, status: 'pending', session_id: null, turns: [], truncated: false }
        if (binding.capture.source !== 'codex_session_jsonl_dir')
          return {
            run_id: runId,
            status: 'unsupported',
            session_id: null,
            turns: [],
            truncated: false,
          }
        if (!binding.sessionId)
          return { run_id: runId, status: 'pending', session_id: null, turns: [], truncated: false }
        return {
          ...(await readConversation(
            getCodexHome(binding.capture.pattern),
            binding.sessionId,
            binding.cwd
          )),
          run_id: runId,
        }
      }
      const context = services.agentSessionStore.getCaptureContext(workspaceId, agentId)
      const config = services.agentRuntime.peekAgentLaunchConfig(workspaceId, agentId)
      const preset = config?.commandPresetId
        ? services.settings.getCommandPreset(config.commandPresetId)
        : undefined
      const capture = context?.capture ?? config?.sessionIdCapture ?? preset?.sessionIdCapture
      const sessionId = services.agentSessionStore.getLastSessionId(workspaceId, agentId)
      if (capture?.source !== 'codex_session_jsonl_dir')
        return { status: 'unsupported', session_id: null, turns: [], truncated: false }
      if (!sessionId) return { status: 'pending', session_id: null, turns: [], truncated: false }
      const cwd =
        context?.cwd ?? services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
      return readConversation(getCodexHome(capture.pattern), sessionId, cwd)
    },
    getDispatchWorkspacePath,
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
    deleteWorkspace: async (workspaceId) =>
      services.worktrees.exclusive(workspaceId, async () => {
        const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
        await verifications.deleteWorkspace(workspaceId)
        for (const entry of services.resourceQueue.list(workspaceId))
          if (
            entry.source === 'integration_candidate' &&
            (entry.status === 'queued' || entry.status === 'starting')
          )
            services.resourceQueue.cancel(entry.id)
        await lifecycle.deleteWorkspaceShell(workspaceId)
        for (const agent of workspace.agents) {
          services.resourceQueue.cancelAgent(workspaceId, agent.id)
          services.agentRuntime.cancelPendingStart(workspaceId, agent.id)
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
          services.dispatchSkillActivationStore.deleteWorkspace(workspaceId)
          services.dispatchLedgerStore.deleteWorkspaceDispatches(workspaceId)
          services.git.deleteWorkspace(workspaceId)
          services.skillPackChangeStore.deleteWorkspace(workspaceId)
          services.skillSnapshotStore.deleteWorkspace(workspaceId)
          services.workspaceStore.deleteWorkspace(workspaceId)
        })
        if (services.settings.publicAppState.get('active_workspace_id')?.value === workspaceId) {
          services.settings.publicAppState.set('active_workspace_id', null)
        }
      }),
    addWorker: (workspaceId, input) => services.workspaceStore.addWorker(workspaceId, input),
    addWorkers: (workspaceId, inputs, launchConfig) =>
      services.workspaceStore.addWorkers(workspaceId, inputs, (workers) => {
        if (launchConfig)
          for (const worker of workers)
            services.agentRunStore.saveLaunchConfig(workspaceId, worker.id, launchConfig)
      }),
    renameWorker: (workspaceId, workerId, name) =>
      services.workspaceStore.renameWorker(workspaceId, workerId, name),
    setWorkerAvatar: (workspaceId, workerId, avatar) =>
      services.workspaceStore.setWorkerAvatar(workspaceId, workerId, avatar),
    deleteWorker: (workspaceId, workerId) => {
      services.resourceQueue.cancelAgent(workspaceId, workerId)
      services.agentRuntime.cancelPendingStart(workspaceId, workerId)
      services.worktrees.assertCanChangeWorkers(workspaceId)
      verifications.assertWorkerIdle(workspaceId, workerId)
      const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
      if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
      services.agentRuntime.deleteAgentLaunchConfig(workspaceId, workerId)
      runDataMutation(() => {
        services.memoryDreamGeneration.recordWorkerMessageDeletion(workspaceId, workerId)
        services.reportOutbox.deleteWorkerEntries(workspaceId, workerId)
        services.dispatchSkillActivationStore.deleteWorker(workspaceId, workerId)
        services.dispatchLedgerStore.deleteWorkerDispatches(workspaceId, workerId)
        services.skillSnapshotStore.deleteAgent(workspaceId, workerId)
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
    collaborationStats: createCollaborationStatsQuery(services.db),
    attention: createActivityAttentionQuery(services.db),
    deliveryHistory: createWorkspaceDeliveryQuery(services.db, services.dispatchLedgerStore),
    recoveryIndex: createRecoveryIndex(services.db, services.tasksFileService.readTasks),
    dataRetention: createDataRetention(services.db),
    createBackup: (output, nativeIds) => {
      if (!services.dataDir) throw new ConflictError('Backups require a persistent data directory')
      return createDataBackup(services.db, services.dataDir, output, nativeIds)
    },
    onboarding: createWorkspaceOnboarding(services.db),
    listDispatches: services.dispatchLedgerStore.listWorkspaceDispatches,
    getDispatch: services.dispatchLedgerStore.getDispatchById,
    acceptDispatchReport: (workspaceId, dispatchId, reportRevision) => {
      const dispatch = services.dispatchLedgerStore.acceptReport(
        workspaceId,
        dispatchId,
        reportRevision
      )
      services.workflowRuntime.recordDispatchReport(workspaceId, dispatch)
      return dispatch
    },
    sendDispatchFeedback: (workspaceId, dispatchId, text) => {
      services.worktrees.assertIdle(workspaceId)
      const previous = services.dispatchLedgerStore.getDispatchById(workspaceId, dispatchId)
      if (previous) assertWorkerAvailable(services.db, workspaceId, previous.toAgentId)
      if (
        previous?.status === 'reported' &&
        services.workflowRuntime.rerunForDispatch(workspaceId, dispatchId, text)
      )
        return previous
      try {
        return services.teamOps.sendDispatchFeedback(workspaceId, dispatchId, text)
      } finally {
        const current = services.dispatchLedgerStore.getDispatchById(workspaceId, dispatchId)
        if (previous?.status === 'reported' && current && current.status !== 'reported') {
          services.workflowRuntime.recordDispatchReopened(workspaceId, dispatchId)
        }
      }
    },
    listWorkers: (workspaceId) => {
      // A single GROUP BY replaces hydrating every dispatch row on this
      // twice-a-second UI poll path.
      const pendingByWorker = services.dispatchLedgerStore.countPendingByWorker(workspaceId)
      return services.workspaceStore.listWorkers(workspaceId).map((worker) => {
        const tree = services.worktrees.get(workspaceId, worker.id)
        const clarification = services.dispatchSkillActivationStore.clarificationForWorker(
          workspaceId,
          worker.id
        )
        return {
          ...worker,
          ...(clarification ? { clarification } : {}),
          ...(tree
            ? {
                worktreeBranch: tree.branch,
                workingDirectory: tree.workspacePath,
                ...(tree.error ? { worktreeError: tree.error } : {}),
              }
            : {}),
          pendingTaskCount: pendingByWorker.get(worker.id) ?? worker.pendingTaskCount,
        }
      })
    },
    getLastPtyLineForAgent: (workspaceId, agentId) =>
      services.dispatchSkillActivationStore.clarificationForWorker(workspaceId, agentId)
        ? null
        : (services.workerOutputTracker?.getLastPtyLine(workspaceId, agentId) ?? null),
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
    getRunInputSequence: lifecycle.getRunInputSequence,
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
    memoryDreamGeneration: services.memoryDreamGeneration,
    skills,
    requestMemoryDream: memoryDreamRuntime.request,
    requestMemoryDreamGeneration: memoryDreamRuntime.requestGeneration,
    requestMemoryDreamWorkerReview: memoryDreamRuntime.requestWorkerReview,
    workflows: services.workflowRuntime,
    ...externalGoals,
    remote: {
      permissions: services.remotePermissions,
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
    createUiBootstrap: () => services.uiAuth.createBootstrap(),
    exchangeUiBootstrap: (token) => services.uiAuth.exchangeBootstrap(token),
    getRemoteTunnelSecret: () => services.uiAuth.getRemoteTunnelSecret(),
    stopAgentRun: stopTerminalRun,
    validateRemoteTunnelSecret: (secret) => services.uiAuth.validateRemoteTunnelSecret(secret),
    validateAgentToken: (agentId, token) =>
      services.agentRuntime.validateAgentToken(agentId, token),
    validateSupervisorToken: (token) => services.uiAuth.validateSupervisorToken(token),
    validateUiToken: (token) => services.uiAuth.validate(token),
  }
}
