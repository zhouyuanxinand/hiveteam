import { isWorkspaceLanguage, type WorkspaceSummary } from '../shared/types.js'
import { prepareDefaultWorkspaceSkillPacks } from './default-workspace-skill-pack.js'
import { BadRequestError } from './http-errors.js'
import { autostartOrchestrator, type OrchestratorStartResult } from './orchestrator-autostart.js'
import { seedOrchestratorLaunchConfig } from './orchestrator-launch.js'
import type { CreateWorkspaceBody } from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import { SkillPackChangeError } from './skill-pack-operation-errors.js'
import { validateWorkspacePath } from './workspace-path-validation.js'
import { getOrchestratorId } from './workspace-store-support.js'

type CreatedWorkspace = WorkspaceSummary & { orchestrator_start: OrchestratorStartResult }

// Concurrent copies of a slow create request must share both the record and PTY.
// Scope work to its runtime and release it on completion, including failures.
const pendingCreations = new WeakMap<RuntimeStore, Map<string, Promise<CreatedWorkspace>>>()

export const createWorkspaceWithOrchestrator = (
  store: RuntimeStore,
  body: CreateWorkspaceBody,
  hivePort: string
): Promise<CreatedWorkspace> => {
  const path = validateWorkspacePath(body.path)
  const mode = body.initialization_mode ?? 'packs'
  if (mode !== 'basic' && mode !== 'packs')
    throw new BadRequestError('initialization_mode must be basic or packs')
  const language = isWorkspaceLanguage(body.language) ? body.language : 'zh'
  const startupCommand = typeof body.startup_command === 'string' ? body.startup_command : null
  const presetId = body.command_preset_id ?? null
  const autostart = body.autostart_orchestrator !== false
  const key = JSON.stringify([path, body.name, language, presetId, startupCommand, autostart, mode])
  let pending = pendingCreations.get(store)
  if (!pending) {
    pending = new Map()
    pendingCreations.set(store, pending)
  }
  const existing = pending.get(key)
  if (existing) return existing

  const creation = (async (): Promise<CreatedWorkspace> => {
    const attemptId = store.onboarding.begin(mode)
    try {
      const initializeSkills =
        mode === 'packs' ? await prepareDefaultWorkspaceSkillPacks(store, path) : null
      const workspace = store.createWorkspace(path, body.name, language)
      try {
        await initializeSkills?.(workspace.id)
      } catch (error) {
        // Keep an incomplete change journal available for the existing recovery flow.
        if (!(error instanceof SkillPackChangeError && error.code === 'recovery_required')) {
          await store.deleteWorkspace(workspace.id)
        }
        throw error
      }
      seedOrchestratorLaunchConfig(store, store.settings, workspace.id, presetId, startupCommand)
      store.onboarding.complete(attemptId, workspace.id)
      const orchestratorStart = autostart
        ? await autostartOrchestrator(
            store,
            workspace.id,
            getOrchestratorId(workspace.id),
            hivePort
          )
        : { ok: false, error: null, run_id: null }
      return { ...workspace, orchestrator_start: orchestratorStart }
    } catch (error) {
      store.onboarding.fail(attemptId, error)
      throw error
    }
  })().finally(() => pending.delete(key))
  pending.set(key, creation)
  return creation
}
