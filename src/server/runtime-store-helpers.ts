import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { WorkspaceLanguage } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import {
  type AgentLaunchConfigInput,
  createAgentRunStore,
  type InterruptedAgentRun,
} from './agent-run-store.js'
import { createAgentRuntime } from './agent-runtime.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { createAgentSessionStore } from './agent-session-store.js'
import { createDispatchLedgerStore } from './dispatch-ledger-store.js'
import {
  createDispatchMessageRuntime,
  type DispatchMessageRuntime,
} from './dispatch-message-runtime.js'
import { createDispatchSkillActivationStore } from './dispatch-skill-activation-store.js'
import {
  createExecutionPolicyRuntime,
  type ExecutionPolicyRuntime,
} from './execution-policy-runtime.js'
import { createExternalGoalStore } from './external-goal-store.js'
import { createGitTurnCoordinator, type GitTurnCoordinator } from './git-turn-coordinator.js'
import { createGitWorkspaceService } from './git-workspace-service.js'
import { ConflictError } from './http-errors.js'
import { ExecutionCancelledError } from './managed-execution.js'
import { createMemoryDreamGenerationStore } from './memory-dream-generation-store.js'
import { createMessageLogStore } from './message-log-store.js'
import { seedOrchestratorLaunchConfig } from './orchestrator-launch.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { createRemoteAuditStore, type RemoteAuditStore } from './remote-audit-store.js'
import {
  createRemoteConfigSource,
  REMOTE_DAEMON_ID_KEY,
  type RemoteConfigSource,
} from './remote-config-keys.js'
import type { DeviceSessionProvider } from './remote-device-session.js'
import {
  createPersistentDeviceSessionProvider,
  createRemoteDeviceStore,
  type RemoteDeviceStore,
} from './remote-device-store.js'
import { createRemotePairing, type RemotePairing } from './remote-pairing.js'
import {
  createRemotePermissionStore,
  type RemotePermissionStore,
} from './remote-permission-store.js'
import { createReportOutboxStore } from './report-outbox-store.js'
import { recoverRuntimeResources } from './resource-budget-recovery.js'
import {
  createResourceBudgetStore,
  type ResourceBudgetStore,
  ResourceLimitError,
} from './resource-budget-store.js'
import { createResourceQueueAuthorization } from './resource-queue-authorization.js'
import { createResourceStartQueue, type ResourceStartQueue } from './resource-start-queue.js'
import { openRuntimeDatabase } from './runtime-database.js'
import { acquireRuntimeOwner, type RuntimeOwner } from './runtime-owner-lock.js'
import { buildRuntimeRestartPolicy } from './runtime-restart-policy.js'
import { createSettingsStore } from './settings-store.js'
import { createSkillPackChangeStore } from './skill-pack-change-store.js'
import { createSkillPackReleaseStore } from './skill-pack-release-store.js'
import { createSkillPackResolver, type SkillPackResolver } from './skill-pack-resolver.js'
import { createSkillSnapshotStore } from './skill-snapshot-store.js'
import { createTasksFileService } from './tasks-file.js'
import { createTasksFileWatcher } from './tasks-file-watcher.js'
import { createTeamDeliveryRuntime, type TeamDeliveryRuntime } from './team-delivery-runtime.js'
import { createTeamMemoryDigestProvider } from './team-memory-digest.js'
import { createTeamMemoryDreamStore } from './team-memory-dream-store.js'
import { createTeamMemoryStore } from './team-memory-store.js'
import { createTeamOperations } from './team-operations.js'
import { createTeamSkillRuntime, type TeamSkillRuntime } from './team-skill-runtime.js'
import { resolveTerminalInputProfile } from './terminal-input-profile.js'
import { createUiAuth } from './ui-auth.js'
import { createWorkerOutputTracker, type WorkerOutputTracker } from './worker-output-tracker.js'
import {
  createWorkerWorktreeRuntime,
  type WorkerWorktreeRuntime,
} from './worker-worktree-runtime.js'
import { createWorkflowRuntime, type WorkflowRuntime } from './workflow-runtime.js'
import { createWorkspaceShellRuntime } from './workspace-shell-runtime.js'
import { createWorkspaceStore } from './workspace-store.js'

export interface RuntimeStoreServices {
  dispatchMessages: DispatchMessageRuntime
  dispatchDelivery: TeamDeliveryRuntime
  resourceQueue: ResourceStartQueue
  resources: ResourceBudgetStore
  owner: RuntimeOwner
  executionPolicies: ExecutionPolicyRuntime
  worktrees: WorkerWorktreeRuntime
  agentRunStore: ReturnType<typeof createAgentRunStore>
  git: ReturnType<typeof createGitWorkspaceService>
  gitTurnCoordinator: GitTurnCoordinator
  agentSessionStore: ReturnType<typeof createAgentSessionStore>
  agentRuntime: ReturnType<typeof createAgentRuntime>
  db: ReturnType<typeof openRuntimeDatabase>
  dataDir: string | null
  dispatchLedgerStore: ReturnType<typeof createDispatchLedgerStore>
  dispatchSkillActivationStore: ReturnType<typeof createDispatchSkillActivationStore>
  externalGoalStore: ReturnType<typeof createExternalGoalStore>
  messageLogStore: ReturnType<typeof createMessageLogStore>
  memoryStore: ReturnType<typeof createTeamMemoryStore>
  memoryDreamStore: ReturnType<typeof createTeamMemoryDreamStore>
  memoryDreamGeneration: ReturnType<typeof createMemoryDreamGenerationStore>
  reportOutbox: ReturnType<typeof createReportOutboxStore>
  remoteAudit: RemoteAuditStore
  remoteConfig: RemoteConfigSource
  remoteDevices: RemoteDeviceStore
  remoteSessions: DeviceSessionProvider
  remotePairing: RemotePairing
  remotePermissions: RemotePermissionStore
  settings: ReturnType<typeof createSettingsStore>
  skillPackChangeStore: ReturnType<typeof createSkillPackChangeStore>
  skillPackReleaseStore: ReturnType<typeof createSkillPackReleaseStore>
  skillPackResolver: SkillPackResolver | undefined
  skillSnapshotStore: ReturnType<typeof createSkillSnapshotStore>
  shellRuntime: ReturnType<typeof createWorkspaceShellRuntime>
  tasksFileWatcher: ReturnType<typeof createTasksFileWatcher>
  tasksFileWatchCallbacks: Set<(workspaceId: string, content: string) => void>
  tasksFileService: ReturnType<typeof createTasksFileService>
  teamOps: ReturnType<typeof createTeamOperations>
  teamSkillRuntime: TeamSkillRuntime
  uiAuth: ReturnType<typeof createUiAuth>
  workerOutputTracker: WorkerOutputTracker | null
  workflowRuntime: WorkflowRuntime
  workspaceStore: ReturnType<typeof createWorkspaceStore>
}

interface CreateRuntimeStoreServicesOptions {
  agentManager?: AgentManager
  dataDir?: string
}

interface CreateRuntimeStoreLifecycleOptions {
  agentManager?: AgentManager
  onAgentStarted?: (workspaceId: string, agentId: string) => void | Promise<void>
  services: RuntimeStoreServices
}

export interface AutoResumeResult {
  queueId?: string
  agentId: string
  error: string | null
  ok: boolean
  runId: string | null
  workspaceId: string
}

const notifyTasksUpdated = (
  callbacks: Set<(workspaceId: string, content: string) => void>,
  workspaceId: string,
  content: string
) => {
  for (const callback of callbacks) {
    callback(workspaceId, content)
  }
}

export const createRuntimeStoreServices = (
  options: CreateRuntimeStoreServicesOptions = {}
): RuntimeStoreServices => {
  const owner = acquireRuntimeOwner(options.dataDir)
  let db: ReturnType<typeof openRuntimeDatabase> | undefined
  try {
    db = openRuntimeDatabase(owner.dataDir ?? undefined)
    const resources = createResourceBudgetStore(db, { runtimeInstanceId: owner.runtimeInstanceId })
    return buildRuntimeStoreServices(options, db, resources, owner)
  } catch (error) {
    if (db?.open) db.close()
    owner.close()
    throw error
  }
}

const buildRuntimeStoreServices = (
  options: CreateRuntimeStoreServicesOptions,
  db: ReturnType<typeof openRuntimeDatabase>,
  resources: ResourceBudgetStore,
  owner: RuntimeOwner
): RuntimeStoreServices => {
  const git = createGitWorkspaceService(db)
  const messageLogStore = createMessageLogStore(db)
  const dispatchLedgerStore = createDispatchLedgerStore(db)
  const dispatchSkillActivationStore = createDispatchSkillActivationStore(db)
  const externalGoalStore = createExternalGoalStore(db)
  const reportOutbox = createReportOutboxStore(db)
  const agentRunStore = createAgentRunStore(db)
  const agentSessionStore = createAgentSessionStore(db)
  const settings = createSettingsStore(db)
  const skillPackChangeStore = createSkillPackChangeStore(db)
  const skillPackReleaseStore = createSkillPackReleaseStore(db)
  const skillPackResolver = options.dataDir
    ? createSkillPackResolver({
        cacheRoot: join(options.dataDir, 'skill-packs'),
        releaseStore: skillPackReleaseStore,
      })
    : undefined
  const skillSnapshotStore = createSkillSnapshotStore(db)
  const memoryStore = createTeamMemoryStore(db)
  const memoryDreamStore = createTeamMemoryDreamStore(db, memoryStore)
  const memoryDreamGeneration = createMemoryDreamGenerationStore(
    db,
    memoryStore,
    memoryDreamStore,
    messageLogStore
  )
  if (!settings.internalAppState.get(REMOTE_DAEMON_ID_KEY)?.value) {
    settings.internalAppState.set(REMOTE_DAEMON_ID_KEY, randomUUID())
  }
  const remoteConfig = createRemoteConfigSource({ get: settings.internalAppState.get })
  const remoteDevices = createRemoteDeviceStore(db)
  const remoteSessions = createPersistentDeviceSessionProvider(remoteDevices)
  const remoteAudit: RemoteAuditStore = createRemoteAuditStore(db, (error) =>
    remotePermissions.blockAfterAuditFailure(error)
  )
  const remotePermissions: RemotePermissionStore = createRemotePermissionStore(db, remoteAudit)
  const queueAuthorization = createResourceQueueAuthorization(db, remotePermissions, remoteAudit)
  const resourceQueue = createResourceStartQueue({
    db,
    budget: resources,
    validateRemoteGrant: queueAuthorization.validate,
    auditExecution: queueAuthorization.auditExecution,
  })
  const remotePairing = createRemotePairing({
    audit: remoteAudit,
    deviceStore: remoteDevices,
    getDaemonId: remoteConfig.getDaemonId,
    getGatewayUrl: remoteConfig.getGatewayUrl,
  })
  const tasksFileService = createTasksFileService()
  const tasksFileWatchCallbacks = new Set<(workspaceId: string, content: string) => void>()
  const tasksFileWatcher = createTasksFileWatcher({
    onTasksUpdated: (workspaceId, content) => {
      notifyTasksUpdated(tasksFileWatchCallbacks, workspaceId, content)
    },
  })
  const uiAuth = createUiAuth()
  const shellRuntime = createWorkspaceShellRuntime(options.agentManager, resources)

  resources.withTransaction(() => {
    recoverRuntimeResources(db, resources)
    agentRunStore.markUnfinishedRunsStale()
  })

  const workspaceStore = createWorkspaceStore(db, dispatchLedgerStore.listOpenDispatchKinds())
  const worktrees = createWorkerWorktreeRuntime(db, options.dataDir ?? null)
  const teamSkillRuntime = createTeamSkillRuntime({
    activationStore: dispatchSkillActivationStore,
    getAgent: workspaceStore.getAgent,
    getDispatch: dispatchLedgerStore.getDispatchById,
    getWorkspacePath: (workspaceId) =>
      workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path,
    listActivePlacements: skillPackChangeStore.listActivePlacements,
    releaseStore: skillPackReleaseStore,
    ...(skillPackResolver ? { resolver: skillPackResolver } : {}),
  })
  const startExistingWorkspaceWatches = () => {
    for (const workspace of workspaceStore.listWorkspaces()) {
      void tasksFileWatcher.start(workspace.id, workspace.path, workspace.language ?? 'zh')
    }
  }
  const restartPolicy = buildRuntimeRestartPolicy({
    agentRunStore,
    dispatchLedgerStore,
    messageLogStore,
    tasksFileService,
    workspaceStore,
  })
  const workerOutputTracker = options.agentManager
    ? createWorkerOutputTracker(options.agentManager.getOutputBus())
    : null
  const gitTurnCoordinator = createGitTurnCoordinator({
    git,
    outputBus: options.agentManager?.getOutputBus() ?? null,
    workspaceStore,
  })
  const executionPolicies = createExecutionPolicyRuntime({
    db,
    dataDir: options.dataDir ?? null,
    worktrees,
    sessionStore: agentSessionStore,
    getWorkspace: (workspaceId) => workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
    getWorkspacePaths: () => workspaceStore.listWorkspaces().map((workspace) => workspace.path),
    getAgent: workspaceStore.getAgent,
    getCommandPreset: settings.getCommandPreset,
    getConfig: (workspaceId, agentId) => agentRuntime.peekAgentLaunchConfig(workspaceId, agentId),
    getActiveRun: (workspaceId, agentId) =>
      agentRuntime.getActiveRunByAgentId(workspaceId, agentId),
  })
  const memoryDigestProvider = createTeamMemoryDigestProvider(memoryStore, settings)
  const agentRuntime = createAgentRuntime(
    options.agentManager,
    agentRunStore,
    agentSessionStore,
    settings.getCommandPreset,
    teamSkillRuntime,
    (workspaceId, agentId) => {
      workerOutputTracker?.detach(workspaceId, agentId)
      gitTurnCoordinator.detach(workspaceId, agentId)
      if (!workspaceStore.hasAgent(workspaceId, agentId)) return
      workspaceStore.markAgentStopped(workspaceId, agentId)
    },
    restartPolicy,
    (workspaceId, agentId) => workspaceStore.getAgent(workspaceId, agentId),
    memoryDigestProvider,
    (workspaceId): WorkspaceLanguage =>
      workspaceStore.getWorkspaceSnapshot(workspaceId).summary.language ?? 'zh',
    worktrees.withLaunchWorkspace,
    executionPolicies,
    resources,
    (context) => dispatchDelivery.prepareInitialDispatch(context)
  )
  const dispatchDelivery = createTeamDeliveryRuntime({
    db,
    agentRuntime,
    workspaceStore,
    ledger: dispatchLedgerStore,
    outbox: reportOutbox,
    activations: dispatchSkillActivationStore,
    dispatchMemoryDigest: memoryDigestProvider.forDispatch,
    authorize: queueAuthorization.deliverDispatch,
    onSubmitted: (dispatch) =>
      workflowRuntime.recordDispatchSubmitted(dispatch.workspaceId, dispatch.id),
  })
  const teamOps = createTeamOperations({
    messagePurposeForDispatch: (id) =>
      db
        .prepare(`
      WITH RECURSIVE ancestry(id,workspace_id,parent_dispatch_id) AS (
        SELECT id,workspace_id,parent_dispatch_id FROM dispatches WHERE id=?
        UNION
        SELECT parent.id,parent.workspace_id,parent.parent_dispatch_id
        FROM dispatches parent JOIN ancestry child ON parent.id=child.parent_dispatch_id
          AND parent.workspace_id=child.workspace_id
      )
      SELECT 1 FROM ancestry a JOIN memory_dream_reviews r
        ON r.dispatch_id=a.id AND r.workspace_id=a.workspace_id LIMIT 1
    `)
        .get(id)
        ? 'memory_dream_review'
        : 'conversation',
    isWorkflowDispatch: (id) =>
      !!db.prepare('SELECT 1 FROM workflow_step_attempts WHERE dispatch_id=? LIMIT 1').get(id),
    delivery: dispatchDelivery,
    resourceQueue,
    captureDispatchAuthorization: queueAuthorization.captureDispatch,
    withDispatchAuthorization: queueAuthorization.deliverDispatch,
    assertWorkspaceWritable: worktrees.assertIdle,
    agentRuntime,
    captureBaseHeadSha: (workspaceId, workerId) => {
      const workspacePath = worktrees.path(
        workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
        workerId
      )
      return git.getHeadSha(workspaceId, workspacePath)
    },
    createDispatch: dispatchLedgerStore.createDispatch,
    createDispatchActivation: dispatchSkillActivationStore.insert,
    deleteDispatch: dispatchLedgerStore.deleteDispatch,
    deleteMessage: messageLogStore.deleteMessage,
    findOpenDispatch: dispatchLedgerStore.findOpenDispatch,
    findOpenDispatchById: dispatchLedgerStore.findOpenDispatchById,
    getDispatchById: dispatchLedgerStore.getDispatchById,
    getDispatchActivation: dispatchSkillActivationStore.get,
    clarificationForWorker: dispatchSkillActivationStore.clarificationForWorker,
    listOpenWorkspaceDispatches: (workspaceId) =>
      dispatchLedgerStore
        .listWorkspaceDispatches(workspaceId)
        .filter(
          (dispatch) =>
            dispatch.status === 'queued' ||
            dispatch.status === 'submitted' ||
            dispatch.status === 'failed'
        ),
    insertMessage: messageLogStore.insertMessage,
    markDispatchCancelled: dispatchLedgerStore.markCancelled,
    markDispatchDeliveryFailed: dispatchLedgerStore.markDeliveryFailed,
    markDispatchReportedByWorker: dispatchLedgerStore.markReportedByWorker,
    markDispatchSubmitted: dispatchLedgerStore.markSubmitted,
    onDispatchSubmitted: (dispatch) =>
      workflowRuntime.recordDispatchSubmitted(dispatch.workspaceId, dispatch.id),
    reportOutbox,
    resolveDispatchActivation: teamSkillRuntime.resolveDispatchActivation,
    reopenReportedDispatch: dispatchLedgerStore.reopenReportedDispatch,
    runDataMutation: (mutation) => db.transaction(mutation)(),
    setDispatchBaseHeadSha: dispatchLedgerStore.setBaseHeadSha,
    workspaceStore,
  })
  const workflowRuntime = createWorkflowRuntime({
    db,
    teamOps,
    workspaceStore,
    getDispatch: dispatchLedgerStore.getDispatchById,
    cancellationConfirmed: (id) =>
      dispatchDelivery.health.get(id)?.cancellation_confirmed_at != null,
    canDispatch: (id) => !worktrees.isBusy(id),
  })
  resourceQueue.setAgentCancellation((workspaceId, agentId, pause) => {
    if (pause && workspaceStore.hasAgent(workspaceId, agentId))
      workspaceStore.markAgentManuallyStopped(workspaceId, agentId)
    agentRuntime.cancelPendingStart(workspaceId, agentId)
  })
  startExistingWorkspaceWatches()

  return {
    dispatchDelivery,
    dispatchMessages: createDispatchMessageRuntime(db, dispatchDelivery, worktrees.assertIdle),
    resourceQueue,
    resources,
    owner,
    executionPolicies,
    worktrees,
    agentRunStore,
    git,
    gitTurnCoordinator,
    agentSessionStore,
    agentRuntime,
    db,
    dataDir: options.dataDir ?? null,
    dispatchLedgerStore,
    dispatchSkillActivationStore,
    externalGoalStore,
    messageLogStore,
    memoryStore,
    memoryDreamStore,
    memoryDreamGeneration,
    reportOutbox,
    remoteAudit,
    remoteConfig,
    remoteDevices,
    remotePermissions,
    remoteSessions,
    remotePairing,
    settings,
    skillPackChangeStore,
    skillPackReleaseStore,
    skillPackResolver,
    skillSnapshotStore,
    shellRuntime,
    tasksFileWatcher,
    tasksFileWatchCallbacks,
    tasksFileService,
    teamOps,
    teamSkillRuntime,
    uiAuth,
    workerOutputTracker,
    workflowRuntime,
    workspaceStore,
  }
}

export const createRuntimeStoreLifecycle = ({
  agentManager,
  onAgentStarted,
  services,
}: CreateRuntimeStoreLifecycleOptions) => {
  const AUTO_RESUME_INTERVAL_MS = 500
  let autoResumePromise: Promise<AutoResumeResult[]> | null = null
  let autoResumeStopped = false
  const stopAutoResume = () => {
    autoResumeStopped = true
  }
  let runtimeHivePort = ''
  let handlersInstalled = false
  const installQueueHandlers = (hivePort: string, workspaceId?: string) => {
    if (!hivePort) return
    runtimeHivePort ||= hivePort
    services.workflowRuntime.resume(runtimeHivePort, workspaceId)
    if (handlersInstalled) return
    handlersInstalled = true
    for (const source of ['dispatch', 'scenario', 'recovery'] as const) {
      services.resourceQueue.registerHandler(source, async (entry) => {
        if (
          !entry.agent_id ||
          services.workspaceStore.isAgentManuallyStopped(entry.workspace_id, entry.agent_id)
        )
          throw new ConflictError('Agent was manually stopped; start it explicitly to resume')
        if (
          source === 'recovery' &&
          entry.payload.auto_resume === true &&
          !services.workspaceStore.getWorkspaceRecoverySettings(entry.workspace_id)
            .autoResumeOnRestart
        )
          throw new ConflictError('Workspace auto-resume is disabled')
        const run = await startAgent(entry.workspace_id, entry.agent_id, {
          hivePort: runtimeHivePort,
          ...(entry.payload.auto_resume === true ? { autoResume: true } : {}),
        })
        if (run.status === 'error') throw new ConflictError('Queued agent failed to start')
        return { runId: run.runId }
      })
    }
  }
  const enqueueRecovery = (
    workspaceId: string,
    agentId: string,
    error: ResourceLimitError,
    autoResume = false
  ) => {
    const agent = services.workspaceStore.getAgent(workspaceId, agentId)
    return services.resourceQueue.enqueue({
      workspaceId,
      agentId,
      executionKey: `agent:${agentId}`,
      kind: agent.role === 'orchestrator' ? 'orchestrator' : 'worker',
      source: 'recovery',
      payload: { auto_resume: autoResume },
      reason: error.reason,
    })
  }

  const startAgent = async (
    workspaceId: string,
    agentId: string,
    input: { autoResume?: boolean; hivePort: string }
  ): Promise<LiveAgentRun> => {
    installQueueHandlers(input.hivePort, workspaceId)
    services.workspaceStore.getAgent(workspaceId, agentId)
    services.workspaceStore.markAgentStarted(workspaceId, agentId)
    try {
      const run = await services.agentRuntime.startAgent(
        services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
        agentId,
        { ...input, hivePort: runtimeHivePort || input.hivePort }
      )
      if (run.status === 'error') {
        services.workspaceStore.markAgentStopped(workspaceId, agentId)
      } else {
        services.workerOutputTracker?.attach(workspaceId, agentId, run.runId, run.output)
        const launchConfig = services.agentRuntime.peekAgentLaunchConfig(workspaceId, agentId)
        services.gitTurnCoordinator.attach({
          agentId,
          command: launchConfig?.interactiveCommand ?? launchConfig?.command ?? '',
          initialOutput: run.output,
          runId: run.runId,
          workspaceId,
          workspacePath: services.worktrees.path(
            services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
            agentId
          ),
        })
        queueMicrotask(() => {
          services.dispatchDelivery.wake()
          void services.teamOps
            .replayQueuedDispatches(workspaceId, agentId)
            .catch((error: unknown) => {
              console.error('[hive] queued dispatch replay failed after agent start', {
                agentId,
                error: error instanceof Error ? error.message : String(error),
                workspaceId,
              })
            })
          if (onAgentStarted) {
            void Promise.resolve(onAgentStarted(workspaceId, agentId)).catch((error: unknown) => {
              console.error('[hive] post-agent-start bookkeeping failed', {
                agentId,
                error: error instanceof Error ? error.message : String(error),
                workspaceId,
              })
            })
          }
        })
      }
      return run
    } catch (error) {
      services.workspaceStore.markAgentStopped(workspaceId, agentId)
      throw error
    }
  }

  services.teamOps.setAgentStarter((workspaceId, agentId, hivePort) =>
    startAgent(workspaceId, agentId, { hivePort })
  )
  const autostartConfiguredAgents = async (input: { hivePort: string }) => {
    installQueueHandlers(input.hivePort)
    if (!agentManager) return []
    const starts = services.workspaceStore.listWorkspaces().flatMap((workspace) => {
      seedOrchestratorLaunchConfig(services.agentRuntime, services.settings, workspace.id)
      return services.workspaceStore
        .getWorkspaceSnapshot(workspace.id)
        .agents.filter(
          (agent) =>
            agent.retiredAt === undefined &&
            !agent.preparationState &&
            !services.agentRuntime.getActiveRunByAgentId(workspace.id, agent.id) &&
            !services.workspaceStore.isAgentManuallyStopped?.(workspace.id, agent.id) &&
            services.agentRuntime.peekAgentLaunchConfig(workspace.id, agent.id)
        )
        .map(async (agent) => {
          try {
            const run = await startAgent(workspace.id, agent.id, input)
            return {
              agent_id: agent.id,
              error: null,
              ok: true,
              run_id: run.runId,
              workspace_id: workspace.id,
            }
          } catch (error) {
            const queued =
              error instanceof ResourceLimitError
                ? enqueueRecovery(workspace.id, agent.id, error)
                : null
            return {
              ...(queued ? { queue_id: queued.id } : {}),
              agent_id: agent.id,
              error: error instanceof Error ? error.message : String(error),
              ok: false,
              run_id: null,
              workspace_id: workspace.id,
            }
          }
        })
    })
    return Promise.all(starts)
  }

  const autoResumeInterruptedAgents = async (input: { hivePort: string }) => {
    if (autoResumeStopped) return Promise.resolve([])
    installQueueHandlers(input.hivePort)
    if (autoResumePromise) return autoResumePromise

    autoResumePromise = (async () => {
      if (!agentManager) return []

      const latestByAgent = new Map<string, InterruptedAgentRun>()
      for (const candidate of services.agentRunStore.listInterruptedRuns()) {
        const current = latestByAgent.get(`${candidate.workspaceId}:${candidate.agentId}`)
        if (!current || current.startedAt < candidate.startedAt) {
          latestByAgent.set(`${candidate.workspaceId}:${candidate.agentId}`, candidate)
        }
      }

      const candidates = [...latestByAgent.values()].sort((left, right) => {
        const leftAgent = services.workspaceStore
          .getWorkspaceSnapshot(left.workspaceId)
          .agents.find((agent) => agent.id === left.agentId)
        const rightAgent = services.workspaceStore
          .getWorkspaceSnapshot(right.workspaceId)
          .agents.find((agent) => agent.id === right.agentId)
        const leftPriority = leftAgent?.role === 'orchestrator' ? 0 : 1
        const rightPriority = rightAgent?.role === 'orchestrator' ? 0 : 1
        return leftPriority - rightPriority || left.agentId.localeCompare(right.agentId)
      })

      const results: AutoResumeResult[] = []
      for (const [index, candidate] of candidates.entries()) {
        if (autoResumeStopped) break
        if (index > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, AUTO_RESUME_INTERVAL_MS))
        }
        if (autoResumeStopped) break

        const settings = services.workspaceStore.getWorkspaceRecoverySettings(candidate.workspaceId)
        if (
          services.workspaceStore.isAgentManuallyStopped?.(candidate.workspaceId, candidate.agentId)
        ) {
          results.push({
            agentId: candidate.agentId,
            error: 'Agent was manually stopped; start it manually to resume.',
            ok: false,
            runId: null,
            workspaceId: candidate.workspaceId,
          })
          continue
        }
        if (!settings.autoResumeOnRestart) {
          console.info(`[hive] auto-resume skipped: workspace ${candidate.workspaceId} is disabled`)
          results.push({
            agentId: candidate.agentId,
            error: 'Workspace auto-resume is disabled.',
            ok: false,
            runId: null,
            workspaceId: candidate.workspaceId,
          })
          continue
        }

        if (candidate.consecutiveFastExits >= 3) {
          console.warn(
            `[hive] auto-resume suspended after ${candidate.consecutiveFastExits} fast exits: ${candidate.agentId}`
          )
          results.push({
            agentId: candidate.agentId,
            error: 'Auto-resume suspended after repeated fast exits; start it manually to retry.',
            ok: false,
            runId: null,
            workspaceId: candidate.workspaceId,
          })
          continue
        }

        if (services.agentRuntime.getActiveRunByAgentId(candidate.workspaceId, candidate.agentId)) {
          continue
        }
        if (
          !services.agentRuntime.peekAgentLaunchConfig(candidate.workspaceId, candidate.agentId)
        ) {
          results.push({
            agentId: candidate.agentId,
            error: 'No agent launch config available.',
            ok: false,
            runId: null,
            workspaceId: candidate.workspaceId,
          })
          continue
        }

        try {
          const run = await startAgent(candidate.workspaceId, candidate.agentId, {
            autoResume: true,
            hivePort: input.hivePort,
          })
          const ok = run.status !== 'error'
          console.info(
            `[hive] auto-resume ${ok ? 'started' : 'failed'}: ${candidate.agentId} (${run.runId})`
          )
          results.push({
            agentId: candidate.agentId,
            error: ok ? null : `${candidate.agentId} failed to resume`,
            ok,
            runId: run.runId,
            workspaceId: candidate.workspaceId,
          })
        } catch (error) {
          const queued =
            !autoResumeStopped && error instanceof ResourceLimitError
              ? enqueueRecovery(candidate.workspaceId, candidate.agentId, error, true)
              : null
          const message = error instanceof Error ? error.message : String(error)
          if (!(autoResumeStopped && error instanceof ExecutionCancelledError)) {
            console.error(`[hive] auto-resume failed: ${candidate.agentId}`, error)
          }
          results.push({
            ...(queued ? { queueId: queued.id } : {}),
            agentId: candidate.agentId,
            error: message,
            ok: false,
            runId: null,
            workspaceId: candidate.workspaceId,
          })
        }
      }
      return results
    })().finally(() => {
      autoResumePromise = null
    })

    return autoResumePromise
  }

  return {
    stopAutoResume,
    close: async () => {
      stopAutoResume()
      // A recovery may still be finishing a cancelled start or waiting between
      // candidates. Its final state writes must settle before SQLite closes.
      await autoResumePromise
      await services.resourceQueue.close()
      await services.shellRuntime.close()
      await services.agentRuntime.close()
      await services.executionPolicies.close()
      await services.tasksFileWatcher.close()
      services.workerOutputTracker?.closeAll()
      services.gitTurnCoordinator.close()
      services.agentRunStore.close?.()
      services.remotePairing.dispose()
      await services.remoteAudit.flush()
      services.remotePermissions.close()
      services.db.close()
      services.owner.close()
    },
    configureAgentLaunch: (workspaceId: string, agentId: string, input: AgentLaunchConfigInput) => {
      services.workspaceStore.getAgent(workspaceId, agentId)
      services.agentRuntime.configureAgentLaunch(workspaceId, agentId, input)
    },
    peekAgentLaunchConfig: (workspaceId: string, agentId: string) =>
      services.agentRuntime.peekAgentLaunchConfig(workspaceId, agentId),
    deleteWorkspaceShell: (workspaceId: string) =>
      services.shellRuntime.deleteWorkspace(workspaceId),
    closeWorkspaceShell: (workspaceId: string, runId: string) =>
      services.shellRuntime.closeRun(workspaceId, runId),
    getLiveRun: (runId: string) =>
      services.shellRuntime.getLiveRun(runId) ?? services.agentRuntime.getLiveRun(runId),
    getRunInputSequence: (runId: string) => {
      if (!agentManager) throw new Error('Agent manager is required for PTY input tracking')
      return agentManager.getInputSequence(runId)
    },
    getPtyOutputBus: (): PtyOutputBus => {
      if (!agentManager) throw new Error('Agent manager is required for PTY output subscriptions')
      return agentManager.getOutputBus()
    },
    listTerminalRuns: (workspaceId: string) => [
      ...services.workspaceStore.getWorkspaceSnapshot(workspaceId).agents.flatMap((agent) => {
        const run = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
        if (!run) return []
        const launchConfig = services.agentRuntime.peekAgentLaunchConfig(workspaceId, agent.id)
        return [
          {
            agent_id: agent.id,
            agent_name: agent.name,
            run_id: run.runId,
            status: run.status,
            thread_id: services.agentSessionStore.getLastSessionId(workspaceId, agent.id) ?? null,
            terminal_input_profile: resolveTerminalInputProfile(launchConfig),
          },
        ]
      }),
      ...services.shellRuntime.listTerminalRuns(workspaceId),
    ],
    startAgent,
    startWorkspaceShell: (workspaceId: string) =>
      services.shellRuntime.start(
        services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary
      ),
    autostartConfiguredAgents,
    autoResumeInterruptedAgents,
    registerTasksListener: (listener: (workspaceId: string, content: string) => void) => {
      services.tasksFileWatchCallbacks.add(listener)
      return () => {
        services.tasksFileWatchCallbacks.delete(listener)
      }
    },
    startWorkspaceWatch: async (workspaceId: string) => {
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
      await services.tasksFileWatcher.start(
        workspaceId,
        workspace.summary.path,
        workspace.summary.language ?? 'zh'
      )
    },
    writeRunInput: (runId: string, input: Buffer | string) => {
      if (!agentManager) throw new Error('Agent manager is required for PTY stdin writes')
      if (services.shellRuntime.hasRun(runId)) {
        services.shellRuntime.writeInput(runId, input)
        return
      }
      agentManager.writeInput(runId, input)
    },
    pauseTerminalRun: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.pauseRun(runId)
      else services.agentRuntime.pauseRun(runId)
    },
    resizeTerminalRun: (runId: string, cols: number, rows: number) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.resizeRun(runId, cols, rows)
      else services.agentRuntime.resizeAgentRun(runId, cols, rows)
    },
    resumeTerminalRun: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.resumeRun(runId)
      else services.agentRuntime.resumeRun(runId)
    },
    stopTerminalRun: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.stopRun(runId)
      else services.agentRuntime.stopAgentRun(runId)
    },
  }
}
