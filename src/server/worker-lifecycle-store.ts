import type { StaffingPolicy, WorkerLifecycleFields } from '../shared/worker-lifecycle.js'
import { BadRequestError, ConflictError, ForbiddenError, HttpError } from './http-errors.js'
import type { Database } from './sqlite.js'
export interface WorkerLifecycleRow {
  lifecycle_kind: 'persistent' | 'ephemeral'
  spawned_by_agent_id: string | null
  retired_at: number | null
  preparation_state: 'preparing' | 'ready' | 'failed'
  preparation_error: string | null
}
export const workerLifecycleFields = (row: WorkerLifecycleRow): WorkerLifecycleFields => ({
  ...(row.lifecycle_kind === 'ephemeral' ? { lifecycleKind: row.lifecycle_kind } : {}),
  ...(row.spawned_by_agent_id ? { spawnedByAgentId: row.spawned_by_agent_id } : {}),
  ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
  ...(row.preparation_state === 'ready' ? {} : { preparationState: row.preparation_state }),
  ...(row.preparation_error ? { preparationError: row.preparation_error } : {}),
})
export const assertWorkerAvailable = (db: Database, workspaceId: string, workerId: string) => {
  const row = db
    .prepare(
      'SELECT retired_at,preparation_state,preparation_error FROM workers WHERE workspace_id=? AND id=?'
    )
    .get(workspaceId, workerId) as
    | Pick<WorkerLifecycleRow, 'retired_at' | 'preparation_state' | 'preparation_error'>
    | undefined
  if (row?.retired_at != null)
    throw new ConflictError('Worker is retired; create or select an active member')
  if (row && row.preparation_state !== 'ready')
    throw new ConflictError(row.preparation_error ?? 'Worker preparation is still in progress')
}
export const assertAgentLaunchable = (agent: WorkerLifecycleFields | undefined) => {
  if (agent?.retiredAt !== undefined)
    throw new ConflictError('Worker is retired; create or select an active member')
  if (agent?.preparationState)
    throw new ConflictError(agent.preparationError ?? 'Worker preparation is still in progress')
}
export const createWorkerLifecycleStore = (db: Database) => {
  const readPolicy = (workspaceId: string): StaffingPolicy => {
    const row = db
      .prepare(
        'SELECT enabled,allowed_command_preset_ids,max_ephemeral_workers FROM workspace_staffing_policies WHERE workspace_id=?'
      )
      .get(workspaceId) as
      | { enabled: number; allowed_command_preset_ids: string; max_ephemeral_workers: number }
      | undefined
    return row
      ? {
          enabled: row.enabled === 1,
          allowed_command_preset_ids: JSON.parse(row.allowed_command_preset_ids) as string[],
          max_ephemeral_workers: row.max_ephemeral_workers,
        }
      : { enabled: false, allowed_command_preset_ids: [], max_ephemeral_workers: 2 }
  }
  return {
    readPolicy,
    updatePolicy(workspaceId: string, input: StaffingPolicy) {
      if (
        !input ||
        typeof input.enabled !== 'boolean' ||
        !Array.isArray(input.allowed_command_preset_ids) ||
        !input.allowed_command_preset_ids.every((id) => typeof id === 'string' && id.trim()) ||
        !Number.isSafeInteger(input.max_ephemeral_workers) ||
        input.max_ephemeral_workers < 1 ||
        input.max_ephemeral_workers > 20
      )
        throw new BadRequestError(
          'Expected enabled, allowed_command_preset_ids and max_ephemeral_workers (1-20)'
        )
      const presets = [...new Set(input.allowed_command_preset_ids)]
      if (input.enabled && presets.length === 0)
        throw new BadRequestError('Choose at least one allowed command preset')
      db.prepare(
        `INSERT INTO workspace_staffing_policies(workspace_id,enabled,allowed_command_preset_ids,max_ephemeral_workers) VALUES(?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET enabled=excluded.enabled,allowed_command_preset_ids=excluded.allowed_command_preset_ids,max_ephemeral_workers=excluded.max_ephemeral_workers`
      ).run(
        workspaceId,
        input.enabled ? 1 : 0,
        JSON.stringify(presets),
        input.max_ephemeral_workers
      )
      return readPolicy(workspaceId)
    },
    admitSpawn(workspaceId: string, presetId: string, clarification = false) {
      if (!db.inTransaction) throw new Error('Dynamic staffing admission requires a transaction')
      const policy = readPolicy(workspaceId)
      if (!policy.enabled && !clarification)
        throw new ForbiddenError('Dynamic staffing is disabled for this workspace')
      if (
        (policy.enabled || !clarification) &&
        !policy.allowed_command_preset_ids.includes(presetId)
      )
        throw new ForbiddenError('Command preset is not allowed for dynamic staffing')
      const row = db
        .prepare(
          "SELECT COUNT(*) AS count FROM workers WHERE workspace_id=? AND lifecycle_kind='ephemeral' AND retired_at IS NULL"
        )
        .get(workspaceId) as { count: number }
      if (row.count > policy.max_ephemeral_workers)
        throw new ConflictError(
          'Dynamic staffing member limit reached; dismiss an idle temporary member first'
        )
    },
    retire(workspaceId: string, workerId: string) {
      return db
        .transaction(() => {
          const row = db
            .prepare('SELECT retired_at FROM workers WHERE workspace_id=? AND id=?')
            .get(workspaceId, workerId) as { retired_at: number | null } | undefined
          if (!row) throw new HttpError(404, 'Worker not found in workspace')
          if (row.retired_at !== null) return row.retired_at
          if (
            db
              .prepare(
                "SELECT 1 FROM dispatches WHERE workspace_id=? AND to_agent_id=? AND status IN ('queued','submitted','failed') LIMIT 1"
              )
              .get(workspaceId, workerId)
          )
            throw new ConflictError(
              'Worker has open dispatches; report or explicitly cancel them before dismissal'
            )
          const retiredAt = Date.now()
          db.prepare(
            'UPDATE workers SET retired_at=?,manual_stop=1 WHERE workspace_id=? AND id=?'
          ).run(retiredAt, workspaceId, workerId)
          db.prepare(
            'INSERT OR IGNORE INTO resource_agent_pauses(workspace_id,agent_id) VALUES(?,?)'
          ).run(workspaceId, workerId)
          db.prepare('UPDATE agent_runs SET resume_on_restart=0 WHERE agent_id=?').run(workerId)
          return retiredAt
        })
        .immediate()
    },
    recoverPreparation() {
      db.prepare(
        "UPDATE workers SET preparation_state='failed',preparation_error='Worker preparation was interrupted by runtime shutdown; inspect its worktree before dismissing or deleting the member' WHERE preparation_state='preparing'"
      ).run()
    },
  }
}
