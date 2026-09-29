import type { TeamReviewRecord } from '../shared/team-review.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { ConflictError } from './http-errors.js'
import type { Database } from './sqlite.js'

export const createTeamReviewStore = (db: Database) => {
  const get = (id: string) =>
    db.prepare('SELECT * FROM team_review_requests WHERE id=?').get(id) as
      | TeamReviewRecord
      | undefined
  return {
    get,
    forReviewer: (workspaceId: string, workerId: string) =>
      db
        .prepare('SELECT * FROM team_review_requests WHERE workspace_id=? AND reviewer_id=?')
        .get(workspaceId, workerId) as TeamReviewRecord | undefined,
    list: (workspaceId: string, dispatchId: string) =>
      db
        .prepare(
          'SELECT * FROM team_review_requests WHERE workspace_id=? AND source_dispatch_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50'
        )
        .all(workspaceId, dispatchId) as TeamReviewRecord[],
    create(record: TeamReviewRecord) {
      if (!db.inTransaction)
        throw new Error('Review admission requires the worker creation transaction')
      const source = db
        .prepare('SELECT status,report_revision FROM dispatches WHERE id=? AND workspace_id=?')
        .get(record.source_dispatch_id, record.workspace_id) as
        | { status: string; report_revision: number }
        | undefined
      if (source?.status !== 'reported' || source.report_revision !== record.source_report_revision)
        throw new ConflictError(
          'The source report changed before review admission; request its current version'
        )
      db.prepare(`INSERT INTO team_review_requests
        (id,workspace_id,source_dispatch_id,source_report_revision,source_head_sha,source_base_sha,repository_id,baseline_kind,focus,command_preset_id,requested_by,reviewer_id,review_dispatch_id,created_at,last_error)
        VALUES (@id,@workspace_id,@source_dispatch_id,@source_report_revision,@source_head_sha,@source_base_sha,@repository_id,@baseline_kind,@focus,@command_preset_id,@requested_by,@reviewer_id,@review_dispatch_id,@created_at,@last_error)`).run(
        record
      )
    },
    attach(id: string, dispatch: DispatchRecord) {
      if (!db.inTransaction) throw new Error('Review ownership requires the dispatch transaction')
      const record = get(id)
      if (
        !record ||
        record.review_dispatch_id ||
        record.reviewer_id !== dispatch.toAgentId ||
        record.workspace_id !== dispatch.workspaceId ||
        dispatch.parentDispatchId !== record.source_dispatch_id
      )
        throw new ConflictError('This review already owns a dispatch, or its owner changed')
      db.prepare(
        'UPDATE team_review_requests SET review_dispatch_id=?,last_error=NULL WHERE id=?'
      ).run(dispatch.id, id)
    },
    fail(id: string, message: string) {
      db.prepare('UPDATE team_review_requests SET last_error=? WHERE id=?').run(message, id)
    },
    interrupted() {
      return db
        .prepare(`SELECT r.* FROM team_review_requests r
        JOIN workers w ON w.id=r.reviewer_id
        WHERE r.review_dispatch_id IS NULL AND w.retired_at IS NULL`)
        .all() as TeamReviewRecord[]
    },
    completed() {
      return db
        .prepare(`SELECT r.* FROM team_review_requests r
        JOIN workers w ON w.id=r.reviewer_id
        JOIN dispatches d ON d.id=r.review_dispatch_id
        WHERE w.retired_at IS NULL AND d.status IN ('reported','cancelled')
          AND NOT EXISTS (SELECT 1 FROM dispatches pending WHERE pending.to_agent_id=w.id AND pending.workspace_id=r.workspace_id AND pending.status IN ('queued','submitted','failed'))`)
        .all() as TeamReviewRecord[]
    },
  }
}
