import { randomUUID } from 'node:crypto'
import { SkillPackChangeError } from './skill-pack-operation-errors.js'
import type { Database } from './sqlite.js'

export type WorkspaceInitializationMode = 'basic' | 'packs'
export const createWorkspaceOnboarding = (db: Database) => ({
  begin(mode: WorkspaceInitializationMode) {
    const id = randomUUID()
    db.prepare(
      "INSERT INTO workspace_creation_attempts(id,mode,state,started_at) VALUES(?,?,'pending',?)"
    ).run(id, mode, Date.now())
    return id
  },
  complete(id: string, workspaceId: string) {
    db.prepare(
      "UPDATE workspace_creation_attempts SET state='succeeded',workspace_id=?,completed_at=? WHERE id=? AND state='pending'"
    ).run(workspaceId, Date.now(), id)
  },
  fail(id: string, error: unknown) {
    const code =
      error instanceof SkillPackChangeError ? `pack_${error.code}` : 'initialization_failed'
    db.prepare(
      "UPDATE workspace_creation_attempts SET state='failed',failure_code=?,completed_at=? WHERE id=? AND state='pending'"
    ).run(code, Date.now(), id)
  },
  view(workspaceId: string) {
    const row = db
      .prepare(
        'SELECT mode,started_at,completed_at,first_dispatch_at,first_report_at FROM workspace_creation_attempts WHERE workspace_id=? ORDER BY started_at DESC LIMIT 1'
      )
      .get(workspaceId) as
      | {
          mode: WorkspaceInitializationMode
          started_at: number
          completed_at: number
          first_dispatch_at: number | null
          first_report_at: number | null
        }
      | undefined
    return row
      ? {
          ...row,
          creation_duration_ms: row.completed_at - row.started_at,
          first_report_duration_ms:
            row.first_report_at === null ? null : row.first_report_at - row.started_at,
        }
      : null
  },
  metrics() {
    return db
      .prepare(`SELECT mode,COUNT(*) AS attempts,SUM(state='succeeded') AS succeeded,SUM(state='failed') AS failed,SUM(state='pending') AS interrupted,
      AVG(CASE WHEN state='succeeded' THEN completed_at-started_at END) AS mean_creation_ms,
      AVG(CASE WHEN first_report_at IS NOT NULL THEN first_report_at-started_at END) AS mean_first_report_ms,
      SUM(first_report_at IS NOT NULL) AS reports_observed FROM workspace_creation_attempts GROUP BY mode`)
      .all()
  },
})
export type WorkspaceOnboarding = ReturnType<typeof createWorkspaceOnboarding>
