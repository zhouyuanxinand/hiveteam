import type { Database } from 'better-sqlite3'
import type { DispatchVerification } from '../shared/verification.js'

type VerificationRow = {
  id: string
  workspace_id: string
  dispatch_id: string
  report_revision: number
  head_sha: string
  command: string
  state: DispatchVerification['state']
  output: string
  output_truncated: number
  exit_code: number | null
  error: string | null
  started_at: number
  ended_at: number | null
  accepted_at: number | null
}

const fromRow = (row: VerificationRow): DispatchVerification => ({
  id: row.id,
  workspaceId: row.workspace_id,
  dispatchId: row.dispatch_id,
  reportRevision: row.report_revision,
  headSha: row.head_sha,
  command: row.command,
  state: row.state,
  output: row.output,
  outputTruncated: row.output_truncated === 1,
  exitCode: row.exit_code,
  error: row.error,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  acceptedAt: row.accepted_at,
})

export const createVerificationStore = (db: Database) => ({
  interruptUnfinished() {
    db.prepare(
      `UPDATE dispatch_verifications SET state = 'interrupted', ended_at = ?,
       error = 'Runtime stopped before verification finished. Run verification again.'
       WHERE state = 'running'`
    ).run(Date.now())
  },
  list(workspaceId: string, dispatchId: string) {
    return (
      db
        .prepare(
          `SELECT * FROM dispatch_verifications WHERE workspace_id = ? AND dispatch_id = ?
         ORDER BY started_at DESC, rowid DESC LIMIT 10`
        )
        .all(workspaceId, dispatchId) as VerificationRow[]
    ).map(fromRow)
  },
  insert(run: DispatchVerification) {
    db.prepare(
      `INSERT INTO dispatch_verifications
       (id, workspace_id, dispatch_id, report_revision, head_sha, command, state, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`
    ).run(
      run.id,
      run.workspaceId,
      run.dispatchId,
      run.reportRevision,
      run.headSha,
      run.command,
      run.startedAt
    )
  },
  save(run: DispatchVerification) {
    db.prepare(
      `UPDATE dispatch_verifications SET state = ?, output = ?, output_truncated = ?,
       exit_code = ?, error = ?, ended_at = ? WHERE id = ?`
    ).run(
      run.state,
      run.output,
      Number(run.outputTruncated),
      run.exitCode,
      run.error,
      run.endedAt,
      run.id
    )
  },
  accept(id: string) {
    db.prepare(
      'UPDATE dispatch_verifications SET accepted_at = COALESCE(accepted_at, ?) WHERE id = ?'
    ).run(Date.now(), id)
  },
})
