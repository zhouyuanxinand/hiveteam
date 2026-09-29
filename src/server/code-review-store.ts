import type { CodeReviewRecord } from '../shared/code-review.js'
import type { Database } from './sqlite.js'

export const createCodeReviewStore = (db: Database) => ({
  list(workspaceId: string, dispatchId: string): CodeReviewRecord[] {
    return db
      .prepare(`SELECT * FROM dispatch_code_reviews WHERE workspace_id = ? AND dispatch_id = ?
      ORDER BY created_at DESC, rowid DESC`)
      .all(workspaceId, dispatchId) as CodeReviewRecord[]
  },
  get(id: string): CodeReviewRecord | undefined {
    return db.prepare('SELECT * FROM dispatch_code_reviews WHERE id = ?').get(id) as
      | CodeReviewRecord
      | undefined
  },
  insert(record: CodeReviewRecord) {
    db.prepare(`INSERT INTO dispatch_code_reviews
      (id, workspace_id, dispatch_id, repository_id, source_sha, base_sha, report_revision,
       reviewer_id, reviewer_run_id, reviewer_policy_id, conclusion, summary, created_at, accepted_at, accepted_by)
      VALUES (@id, @workspace_id, @dispatch_id, @repository_id, @source_sha, @base_sha, @report_revision,
       @reviewer_id, @reviewer_run_id, @reviewer_policy_id, @conclusion, @summary, @created_at, @accepted_at, @accepted_by)`).run(
      record
    )
  },
  accept(id: string) {
    db.prepare(`UPDATE dispatch_code_reviews SET accepted_at = COALESCE(accepted_at, ?),
      accepted_by = 'local_user' WHERE id = ? AND conclusion = 'approve'`).run(Date.now(), id)
  },
})
