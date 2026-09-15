import { isWorkspaceLanguage, type WorkspaceSummary } from '../shared/types.js'
import { autostartOrchestrator, type OrchestratorStartResult } from './orchestrator-autostart.js'
import { seedOrchestratorLaunchConfig } from './orchestrator-launch.js'
import type { CreateWorkspaceBody } from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
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
  const language = isWorkspaceLanguage(body.language) ? body.language : 'zh'
  const startupCommand = typeof body.startup_command === 'string' ? body.startup_command : null
  const presetId = body.command_preset_id ?? null
  const autostart = body.autostart_orchestrator !== false
  const key = JSON.stringify([path, body.name, language, presetId, startupCommand, autostart])
  let pending = pendingCreations.get(store)
  if (!pending) {
    pending = new Map()
    pendingCreations.set(store, pending)
  }
  const existing = pending.get(key)
  if (existing) return existing

  const creation = (async (): Promise<CreatedWorkspace> => {
    const workspace = store.createWorkspace(path, body.name, language)
    seedOrchestratorLaunchConfig(store, store.settings, workspace.id, presetId, startupCommand)
    const orchestratorStart = autostart
      ? await autostartOrchestrator(store, workspace.id, getOrchestratorId(workspace.id), hivePort)
      : { ok: false, error: null, run_id: null }
    return { ...workspace, orchestrator_start: orchestratorStart }
  })().finally(() => pending.delete(key))
  pending.set(key, creation)
  return creation
}
