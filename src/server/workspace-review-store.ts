import type { Database } from 'better-sqlite3'
import type {
  ReviewDocument,
  ReviewDraft,
  ReviewSubmission,
  SaveReviewDraft,
} from '../shared/workspace-review.js'
import { ConflictError, HttpError } from './http-errors.js'

export const createWorkspaceReviewStore = (db: Database) => {
  const draft = (workspaceId: string, path: string) =>
    (db
      .prepare(`SELECT path, base_revision, base_content, content, note, version, updated_at
      FROM workspace_review_drafts WHERE workspace_id = ? AND path = ?`)
      .get(workspaceId, path) as ReviewDraft | undefined) ?? null
  const submission = (workspaceId: string, requestId: string) => {
    const row = db
      .prepare(`SELECT request_id, agent_id, kind, path, status, error, created_at
      FROM workspace_review_submissions WHERE workspace_id = ? AND request_id = ?`)
      .get(workspaceId, requestId) as ReviewSubmission | undefined
    if (!row) throw new HttpError(404, 'Submission not found')
    return row
  }
  const updateStatus = (
    workspaceId: string,
    requestId: string,
    status: ReviewSubmission['status'],
    error: string | null
  ) => {
    db.prepare(
      'UPDATE workspace_review_submissions SET status = ?, error = ? WHERE workspace_id = ? AND request_id = ?'
    ).run(status, error, workspaceId, requestId)
  }
  const interrupt = () => {
    db.prepare(
      "UPDATE workspace_review_submissions SET status = 'uncertain', error = ? WHERE status = 'sending'"
    ).run('Runtime restarted during submission. Check the terminal before resending.')
  }
  interrupt()
  return {
    draft,
    submission,
    updateStatus,
    interrupt,
    submissions: (workspaceId: string, path: string) =>
      db
        .prepare(`SELECT request_id, agent_id, kind, path, status, error, created_at
      FROM workspace_review_submissions WHERE workspace_id = ? AND path = ? ORDER BY created_at DESC, rowid DESC LIMIT 8`)
        .all(workspaceId, path) as ReviewSubmission[],
    confirmation: (workspaceId: string, path: string, revision: string) => {
      const row = db
        .prepare(
          'SELECT revision FROM workspace_review_confirmations WHERE workspace_id = ? AND path = ? AND revision = ?'
        )
        .get(workspaceId, path, revision) as { revision: string } | undefined
      return row?.revision ?? null
    },
    confirm: (workspaceId: string, document: ReviewDocument) => {
      db.prepare(`INSERT OR IGNORE INTO workspace_review_confirmations (workspace_id, path, revision, content, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(
        workspaceId,
        document.path,
        document.revision,
        document.content,
        Date.now()
      )
    },
    save: (workspaceId: string, document: ReviewDocument, input: SaveReviewDraft) =>
      db.transaction(() => {
        const previous = draft(workspaceId, input.path)
        if ((previous?.version ?? 0) !== input.expected_version)
          throw new ConflictError('Draft changed in another window. Reload before saving.')
        db.prepare(`INSERT INTO workspace_review_drafts (workspace_id, path, base_revision, base_content, content, note, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, path) DO UPDATE SET
        base_revision = excluded.base_revision, base_content = excluded.base_content, content = excluded.content,
        note = excluded.note, version = excluded.version, updated_at = excluded.updated_at`).run(
          workspaceId,
          input.path,
          document.revision,
          document.content,
          input.content,
          input.note,
          input.expected_version + 1,
          Date.now()
        )
        return draft(workspaceId, input.path) as ReviewDraft
      })(),
    existing: (workspaceId: string, requestId: string, identity: string) => {
      const row = db
        .prepare(
          'SELECT identity FROM workspace_review_submissions WHERE workspace_id = ? AND request_id = ?'
        )
        .get(workspaceId, requestId) as { identity: string } | undefined
      if (!row) return null
      if (row.identity !== identity)
        throw new ConflictError('Request id already belongs to different content')
      return submission(workspaceId, requestId)
    },
    create: (
      workspaceId: string,
      requestId: string,
      kind: ReviewSubmission['kind'],
      path: string | null,
      identity: string,
      payload: string,
      agentId: string
    ) => {
      db.prepare(`INSERT INTO workspace_review_submissions
        (workspace_id, request_id, kind, path, identity, payload, status, error, created_at, agent_id)
        VALUES (?, ?, ?, ?, ?, ?, 'blocked', NULL, ?, ?)`).run(
        workspaceId,
        requestId,
        kind,
        path,
        identity,
        payload,
        Date.now(),
        agentId
      )
    },
  }
}
