import type { DispatchVerification } from '../shared/verification.js'
import type { Database } from './sqlite.js'

type VerificationRow = {
  profile_json: string | null
  subject_json: string | null
  log_bytes: number
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
  ...(row.profile_json ? { profile: JSON.parse(row.profile_json) } : {}),
  ...(row.subject_json ? { subject: JSON.parse(row.subject_json) } : {}),
  logBytes: row.log_bytes,
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
  get(id: string) {
    const row = db.prepare('SELECT * FROM dispatch_verifications WHERE id = ?').get(id) as
      | VerificationRow
      | undefined
    return row ? fromRow(row) : undefined
  },
  interruptUnfinished() {
    db.prepare(
      `UPDATE dispatch_verifications SET state = 'interrupted', ended_at = ?,
       error = 'Runtime stopped before verification finished. Run verification again.'
       WHERE state = 'running'`
    ).run(Date.now())
  },
  list(workspaceId: string, dispatchId: string, candidateId?: string) {
    return (
      db
        .prepare(
          `SELECT * FROM dispatch_verifications WHERE workspace_id = ? AND dispatch_id = ?
         AND ${candidateId ? "json_extract(subject_json,'$.candidate_id') = ?" : 'subject_json IS NULL'}
         ORDER BY started_at DESC, rowid DESC LIMIT 10`
        )
        .all(
          ...(candidateId ? [workspaceId, dispatchId, candidateId] : [workspaceId, dispatchId])
        ) as VerificationRow[]
    ).map(fromRow)
  },
  insert(run: DispatchVerification) {
    db.prepare(
      `INSERT INTO dispatch_verifications
       (id, workspace_id, dispatch_id, report_revision, head_sha, command, state, started_at,profile_json,subject_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      run.id,
      run.workspaceId,
      run.dispatchId,
      run.reportRevision,
      run.headSha,
      run.command,
      run.state,
      run.startedAt,
      run.profile ? JSON.stringify(run.profile) : null,
      run.subject ? JSON.stringify(run.subject) : null
    )
  },
  save(run: DispatchVerification) {
    db.prepare(
      `UPDATE dispatch_verifications SET state = ?, output = ?, output_truncated = ?,
       exit_code = ?, error = ?, ended_at = ?, log_bytes = ? WHERE id = ?`
    ).run(
      run.state,
      run.output,
      Number(run.outputTruncated),
      run.exitCode,
      run.error,
      run.endedAt,
      run.logBytes ?? 0,
      run.id
    )
  },
  accept(id: string) {
    db.prepare(
      'UPDATE dispatch_verifications SET accepted_at = COALESCE(accepted_at, ?) WHERE id = ?'
    ).run(Date.now(), id)
  },
})
