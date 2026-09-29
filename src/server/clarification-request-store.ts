import type { DispatchRecord } from './dispatch-ledger-store.js'
import { ConflictError } from './http-errors.js'
import type { Database } from './sqlite.js'

export interface ClarificationRequestRecord {
  id: string
  workspace_id: string
  requested_by: string
  text: string
  skill_name: string
  worker_id: string
  created_worker: number
  dispatch_id: string | null
  last_error: string | null
  created_at: number
}
export const createClarificationRequestStore = (db: Database) => {
  const get = (id: string) =>
    db.prepare('SELECT * FROM clarification_requests WHERE id=?').get(id) as
      | ClarificationRequestRecord
      | undefined
  const reserved = (workspaceId: string, workerId: string) =>
    Boolean(
      db
        .prepare(
          'SELECT 1 FROM clarification_requests WHERE workspace_id=? AND worker_id=? AND dispatch_id IS NULL'
        )
        .get(workspaceId, workerId)
    )
  return {
    get,
    reserved,
    create(record: ClarificationRequestRecord) {
      if (!db.inTransaction) throw new Error('Clarification ownership requires a transaction')
      if (reserved(record.workspace_id, record.worker_id))
        throw new ConflictError('This member already has a pending interview request')
      db.prepare(`INSERT INTO clarification_requests
        (id,workspace_id,requested_by,text,skill_name,worker_id,created_worker,dispatch_id,last_error,created_at)
        VALUES (@id,@workspace_id,@requested_by,@text,@skill_name,@worker_id,@created_worker,@dispatch_id,@last_error,@created_at)`).run(
        record
      )
    },
    attach(id: string, dispatch: DispatchRecord) {
      if (!db.inTransaction) throw new Error('Clarification dispatch requires a transaction')
      const result = db
        .prepare(`UPDATE clarification_requests SET dispatch_id=?,last_error=NULL
        WHERE id=? AND workspace_id=? AND worker_id=? AND dispatch_id IS NULL`)
        .run(dispatch.id, id, dispatch.workspaceId, dispatch.toAgentId)
      if (result.changes !== 1) throw new ConflictError('Interview ownership changed')
    },
    fail(id: string, error: string) {
      db.prepare('UPDATE clarification_requests SET last_error=? WHERE id=?').run(error, id)
    },
  }
}
