import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { ExecutionPolicySnapshot, UnsafeExecutionGrant } from '../shared/execution-policy.js'

export const createExecutionPolicyStore = (db: Database) => ({
  getGrant(workspaceId: string, agentId: string): UnsafeExecutionGrant | null {
    return (
      (db
        .prepare(`SELECT cli_fingerprint, cli_version, policy_revision, granted_at
        FROM execution_unsafe_grants WHERE workspace_id = ? AND agent_id = ?`)
        .get(workspaceId, agentId) as UnsafeExecutionGrant | undefined) ?? null
    )
  },
  grant(workspaceId: string, agentId: string, grant: UnsafeExecutionGrant) {
    db.transaction(() => {
      db.prepare(`INSERT INTO execution_unsafe_grants
      (workspace_id, agent_id, cli_fingerprint, cli_version, policy_revision, granted_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
      cli_fingerprint = excluded.cli_fingerprint, cli_version = excluded.cli_version,
      policy_revision = excluded.policy_revision, granted_at = excluded.granted_at`).run(
        workspaceId,
        agentId,
        grant.cli_fingerprint,
        grant.cli_version,
        grant.policy_revision,
        grant.granted_at
      )
      db.prepare('INSERT INTO execution_policy_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        randomUUID(),
        workspaceId,
        agentId,
        'local_user',
        'grant_unsafe',
        JSON.stringify(grant),
        Date.now()
      )
    })()
  },
  revoke(workspaceId: string, agentId: string) {
    db.transaction(() => {
      db.prepare('DELETE FROM execution_unsafe_grants WHERE workspace_id = ? AND agent_id = ?').run(
        workspaceId,
        agentId
      )
      db.prepare('INSERT INTO execution_policy_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        randomUUID(),
        workspaceId,
        agentId,
        'local_user',
        'revoke_unsafe',
        '{}',
        Date.now()
      )
    })()
  },
  saveSnapshot(snapshot: ExecutionPolicySnapshot) {
    db.prepare(`INSERT INTO execution_policy_snapshots
      (id, workspace_id, agent_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      snapshot.policy_id,
      snapshot.workspace_id,
      snapshot.agent_id,
      JSON.stringify(snapshot),
      snapshot.created_at
    )
  },
  bindRun(policyId: string, runId: string) {
    db.prepare(
      'UPDATE execution_policy_snapshots SET run_id = ? WHERE id = ? AND run_id IS NULL'
    ).run(runId, policyId)
  },
  latest(workspaceId: string, agentId: string): ExecutionPolicySnapshot | null {
    const row = db
      .prepare(`SELECT snapshot_json FROM execution_policy_snapshots
      WHERE workspace_id = ? AND agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(workspaceId, agentId) as { snapshot_json: string } | undefined
    return row ? (JSON.parse(row.snapshot_json) as ExecutionPolicySnapshot) : null
  },
  forRun(runId: string): ExecutionPolicySnapshot | null {
    const row = db
      .prepare('SELECT snapshot_json FROM execution_policy_snapshots WHERE run_id = ?')
      .get(runId) as { snapshot_json: string } | undefined
    return row ? (JSON.parse(row.snapshot_json) as ExecutionPolicySnapshot) : null
  },
})

export type ExecutionPolicyStore = ReturnType<typeof createExecutionPolicyStore>
