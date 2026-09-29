import type { ExecutionKind } from '../shared/resource-budget.js'
import type { ResourceBudgetStore } from './resource-budget-store.js'
import type { Database } from './sqlite.js'

/** Capture pre-budget executions before other stores replace their unfinished state. */
export const recoverRuntimeResources = (db: Database, resources: ResourceBudgetStore) =>
  resources.withTransaction(() => {
    const agents = db
      .prepare(`SELECT r.run_id, r.agent_id, r.pid, r.started_at,
      COALESCE(c.workspace_id, w.workspace_id, s.id, 'removed-workspace') AS workspace_id,
      CASE WHEN s.id IS NOT NULL THEN 'orchestrator' ELSE 'worker' END AS kind
      FROM agent_runs r LEFT JOIN workers w ON w.id = r.agent_id
      LEFT JOIN agent_launch_configs c ON c.agent_id = r.agent_id
      LEFT JOIN workspaces s ON r.agent_id = s.id || ':orchestrator'
      WHERE r.status IN ('starting', 'running')`)
      .all() as Array<{
      run_id: string
      agent_id: string
      pid: number | null
      started_at: number
      workspace_id: string
      kind: ExecutionKind
    }>
    for (const run of agents)
      resources.adoptLegacyExecution({
        workspaceId: run.workspace_id,
        executionKey: `agent:${run.agent_id}`,
        kind: run.kind,
        agentId: run.agent_id,
        runId: run.run_id,
        pid: run.pid,
        startedAt: run.started_at,
      })

    // Old verification records do not contain a PID. Their process may have
    // survived the old runtime, so interruption bookkeeping cannot free its slot.
    const verifications = db
      .prepare(`SELECT v.id, v.workspace_id, v.started_at, d.to_agent_id
      FROM dispatch_verifications v LEFT JOIN dispatches d ON d.id = v.dispatch_id
      WHERE v.state = 'running'`)
      .all() as Array<{
      id: string
      workspace_id: string
      started_at: number
      to_agent_id: string | null
    }>
    for (const run of verifications)
      resources.adoptLegacyExecution({
        workspaceId: run.workspace_id,
        executionKey: `verification:${run.id}`,
        kind: 'verification',
        agentId: run.to_agent_id,
        runId: run.id,
        pid: null,
        startedAt: run.started_at,
      })
    return resources.recover()
  })
