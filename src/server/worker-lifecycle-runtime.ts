import { generateRoleWorkerName } from '../shared/random-worker-name.js'
import { normalizeWorkerAvatar } from '../shared/worker-avatar.js'
import type { StaffingPolicy } from '../shared/worker-lifecycle.js'
import {
  resolveCommandPresetLaunchConfig,
  resolveStartupCommandLaunchConfig,
} from './agent-launch-resolver.js'
import { BadRequestError, ConflictError, ForbiddenError, HttpError } from './http-errors.js'
import { autostartAgent } from './orchestrator-autostart.js'
import type { CreateWorkerBody } from './route-types.js'
import type { createRuntimeStoreLifecycle, RuntimeStoreServices } from './runtime-store-helpers.js'
import { serializeTeamListItem } from './team-list-serializer.js'
import { createWorkerLifecycleStore } from './worker-lifecycle-store.js'
import type { PinnedWorkerCommit } from './worker-worktree-runtime.js'

interface WorkerCreationOptions {
  pinnedCommit?: PinnedWorkerCommit
  onCreated?: (workerId: string) => void
}

const validateCreation = (body: CreateWorkerBody, dynamic: boolean) => {
  if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 64)
    throw new BadRequestError('Worker name must contain 1-64 characters')
  if (!['coder', 'reviewer', 'tester', 'custom'].includes(body.role))
    throw new BadRequestError('Invalid worker role')
  for (const key of ['isolated', 'autostart'] as const)
    if (body[key] !== undefined && typeof body[key] !== 'boolean')
      throw new BadRequestError(`${key} must be a boolean`)
  for (const key of ['command_preset_id', 'startup_command', 'model', 'description'] as const)
    if (body[key] != null && typeof body[key] !== 'string')
      throw new BadRequestError(`${key} must be a string`)
  if (dynamic && (!body.command_preset_id || body.startup_command != null))
    throw new BadRequestError(
      'Dynamic workers require command_preset_id and cannot override startup_command'
    )
}

export const createWorkerLifecycleRuntime = (
  services: Pick<
    RuntimeStoreServices,
    | 'db'
    | 'workspaceStore'
    | 'agentRunStore'
    | 'agentRuntime'
    | 'settings'
    | 'worktrees'
    | 'resourceQueue'
    | 'executionPolicies'
  >,
  lifecycle: Pick<
    ReturnType<typeof createRuntimeStoreLifecycle>,
    'startAgent' | 'getLiveRun' | 'peekAgentLaunchConfig'
  >
) => {
  const { workspaceStore, worktrees, resourceQueue, agentRuntime } = services
  const store = createWorkerLifecycleStore(services.db)
  const pending = new Set<Promise<unknown>>()
  let closing = false
  const requireOrchestrator = (workspaceId: string, actorId: string) => {
    if (workspaceStore.getAgent(workspaceId, actorId).role !== 'orchestrator')
      throw new ForbiddenError('Only the Orchestrator can manage dynamic members')
  }
  const get = (workspaceId: string, workerId: string) => {
    if (
      !workspaceStore.hasAgent(workspaceId, workerId) ||
      workspaceStore.getAgent(workspaceId, workerId).role === 'orchestrator'
    )
      throw new HttpError(404, 'Worker not found in workspace')
    const worker = workspaceStore.getWorker(workspaceId, workerId)
    if (worker.role === 'orchestrator') throw new HttpError(404, 'Worker not found')
    const tree = worktrees.get(workspaceId, workerId)
    const config = agentRuntime.peekAgentLaunchConfig(workspaceId, workerId)
    return serializeTeamListItem({
      ...worker,
      role: worker.role,
      ...(config?.commandPresetId ? { commandPresetId: config.commandPresetId } : {}),
      ...(tree
        ? {
            worktreeBranch: tree.branch,
            workingDirectory: tree.workspacePath,
            ...(tree.error ? { worktreeError: tree.error } : {}),
          }
        : {}),
    })
  }
  // An interrupted dismissal may have committed before its queued start was cancelled.
  for (const workspace of workspaceStore.listWorkspaces())
    for (const worker of workspaceStore.getWorkspaceSnapshot(workspace.id).agents)
      if (worker.retiredAt !== undefined) resourceQueue.cancelAgent(workspace.id, worker.id)

  const create = async (
    workspaceId: string,
    body: CreateWorkerBody,
    hivePort: string,
    actorId?: string,
    options: WorkerCreationOptions = {},
    clarification = false
  ) => {
    if (closing) throw new ConflictError('Runtime is closing')
    if (actorId) requireOrchestrator(workspaceId, actorId)
    validateCreation(body, actorId !== undefined)
    const presetId = body.command_preset_id ?? null
    const launchConfig = body.startup_command?.trim()
      ? resolveStartupCommandLaunchConfig(services.settings, body.startup_command, presetId)
      : presetId
        ? resolveCommandPresetLaunchConfig(services.settings, presetId, body.model)
        : undefined
    if (presetId && !body.startup_command?.trim() && !launchConfig)
      throw new BadRequestError(`Command preset not found: ${presetId}`)
    let avatar: string | null
    try {
      avatar = normalizeWorkerAvatar(body.avatar)
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : 'Avatar is invalid')
    }
    if (body.isolated) worktrees.assertCanChangeWorkers(workspaceId)
    const worker = workspaceStore.addWorkers(
      workspaceId,
      [
        {
          name: body.name,
          role: body.role,
          avatar,
          ...(body.description == null ? {} : { description: body.description }),
          ...(actorId ? { spawnedByAgentId: actorId } : {}),
          preparing: body.isolated === true,
        },
      ],
      (workers) => {
        if (actorId && presetId) store.admitSpawn(workspaceId, presetId, clarification)
        for (const member of workers)
          if (launchConfig)
            services.agentRunStore.saveLaunchConfig(workspaceId, member.id, launchConfig)
        for (const member of workers) options.onCreated?.(member.id)
      }
    )[0]
    if (!worker) throw new Error('Worker creation returned no member')
    let preparationError: string | null = null
    if (body.isolated) {
      try {
        await worktrees.create(
          workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
          worker.id,
          options.pinnedCommit
        )
      } catch (error) {
        // Desktop creation historically rejects preflight failures before a worktree
        // exists. Keep that contract; dynamic creation retains a diagnosable member.
        if (!actorId && !worktrees.get(workspaceId, worker.id)) {
          agentRuntime.deleteAgentLaunchConfig(workspaceId, worker.id)
          workspaceStore.deleteWorker(workspaceId, worker.id)
          throw error
        }
        preparationError = error instanceof Error ? error.message : String(error)
      }
      // Persist even failures occurring before Git allocated a worktree record.
      workspaceStore.finishWorkerPreparation(workspaceId, worker.id, preparationError)
    }
    if (!preparationError && actorId && launchConfig)
      await services.executionPolicies.authorizeAutomaticWorker(workspaceId, worker.id, actorId)
    const agentStart =
      preparationError || closing || worker.retiredAt !== undefined
        ? {
            ok: false,
            error: preparationError ?? (closing ? 'Runtime is closing' : 'Worker is retired'),
            run_id: null,
          }
        : (body.autostart ?? actorId !== undefined)
          ? await autostartAgent(
              { ...lifecycle, resourceQueue },
              workspaceId,
              worker.id,
              hivePort,
              { missingConfigError: 'No worker launch config available' }
            )
          : { ok: false, error: null, run_id: null }
    return {
      ...get(workspaceId, worker.id),
      agent_start:
        worker.retiredAt !== undefined
          ? { ok: false, error: 'Worker is retired', run_id: agentStart.run_id }
          : agentStart,
    }
  }
  const track = <T>(operation: Promise<T>) => {
    pending.add(operation)
    return operation.finally(() => pending.delete(operation))
  }
  return {
    // A grill request may only create an interviewer using the main agent's
    // configured preset/model. Execution trust requires the local user's saved
    // automatic-member preference; the main agent's grant is never copied.
    createClarification(
      workspaceId: string,
      actorId: string,
      hivePort: string,
      onCreated: (workerId: string) => void
    ) {
      requireOrchestrator(workspaceId, actorId)
      const config = lifecycle.peekAgentLaunchConfig(workspaceId, actorId)
      if (!config?.commandPresetId)
        throw new ConflictError(
          'Select a command preset for the Orchestrator before starting a grill interview'
        )
      const args = config.args ?? []
      let model: string | undefined
      for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        if (arg === '--model' || arg === '-m') model = args[++index]
        else if (arg?.startsWith('--model=')) model = arg.slice('--model='.length)
      }
      const workspace = workspaceStore.getWorkspaceSnapshot(workspaceId)
      const chinese = workspace.summary.language !== 'en'
      return track(
        create(
          workspaceId,
          {
            name: generateRoleWorkerName({
              role: 'custom',
              baseName: chinese ? '需求访谈员' : 'Requirements interviewer',
              usedNames: new Set(workspace.agents.map((worker) => worker.name)),
            }),
            role: 'custom',
            command_preset_id: config.commandPresetId,
            ...(model ? { model } : {}),
            description: chinese
              ? '通过 grill 访谈澄清需求，仅将用户确认的最终结论汇报给主控。'
              : 'Clarify requirements through grill interviews; report only the user-confirmed final conclusions.',
            autostart: false,
          },
          hivePort,
          actorId,
          { onCreated },
          true
        )
      )
    },
    get,
    listRetired: (workspaceId: string) =>
      workspaceStore
        .getWorkspaceSnapshot(workspaceId)
        .agents.filter((worker) => worker.retiredAt !== undefined)
        .map((worker) => get(workspaceId, worker.id)),
    readPolicy(workspaceId: string) {
      workspaceStore.getWorkspaceSnapshot(workspaceId)
      return store.readPolicy(workspaceId)
    },
    updatePolicy(workspaceId: string, policy: StaffingPolicy) {
      workspaceStore.getWorkspaceSnapshot(workspaceId)
      if (Array.isArray(policy?.allowed_command_preset_ids))
        for (const id of policy.allowed_command_preset_ids)
          if (!services.settings.getCommandPreset(id))
            throw new BadRequestError(`Command preset not found: ${id}`)
      return store.updatePolicy(workspaceId, policy)
    },
    create(
      workspaceId: string,
      body: CreateWorkerBody,
      hivePort: string,
      actorId?: string,
      options?: WorkerCreationOptions
    ) {
      return track(create(workspaceId, body, hivePort, actorId, options))
    },
    dismiss(workspaceId: string, workerId: string, actorId?: string) {
      if (closing) throw new ConflictError('Runtime is closing')
      get(workspaceId, workerId)
      if (actorId) {
        requireOrchestrator(workspaceId, actorId)
        if (workspaceStore.getWorker(workspaceId, workerId).lifecycleKind !== 'ephemeral')
          throw new ForbiddenError('The Orchestrator can dismiss only temporary members')
      }
      workspaceStore.retireWorker(workspaceId, workerId)
      resourceQueue.cancelAgent(workspaceId, workerId)
      agentRuntime.cancelPendingStart(workspaceId, workerId)
      const run = agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
      if (run) agentRuntime.stopAgentRun(run.runId)
      return get(workspaceId, workerId)
    },
    async close() {
      closing = true
      await Promise.allSettled(pending)
    },
  }
}
export type WorkerLifecycleRuntime = ReturnType<typeof createWorkerLifecycleRuntime>
