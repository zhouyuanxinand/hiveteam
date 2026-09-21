import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { IntegrationCandidate } from '../shared/integration-candidate.js'
export const createIntegrationCandidateStore = (db: Database) => {
  const decode = (rows: unknown[]) =>
    (rows as Array<{ snapshot: string }>).map(
      (row) => JSON.parse(row.snapshot) as IntegrationCandidate
    )
  return {
    history(id: string) {
      return (
        db
          .prepare(
            'SELECT id,recorded_at,snapshot FROM integration_candidate_events WHERE candidate_id=? ORDER BY recorded_at DESC,rowid DESC LIMIT 100'
          )
          .all(id) as Array<{ id: string; recorded_at: number; snapshot: string }>
      ).map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot) as IntegrationCandidate }))
    },
    get(id: string) {
      return decode(db.prepare('SELECT snapshot FROM integration_candidates WHERE id=?').all(id))[0]
    },
    list(workspaceId: string, dispatchId?: string) {
      return decode(
        db
          .prepare(
            `SELECT snapshot FROM integration_candidates WHERE workspace_id=? ${dispatchId ? 'AND dispatch_id=?' : ''} ORDER BY created_at DESC,rowid DESC`
          )
          .all(...(dispatchId ? [workspaceId, dispatchId] : [workspaceId]))
      )
    },
    insert(candidate: IntegrationCandidate) {
      db.transaction(() => {
        db.prepare('INSERT INTO integration_candidates VALUES(?,?,?,?,?)').run(
          candidate.id,
          candidate.workspace_id,
          candidate.dispatch_id,
          JSON.stringify(candidate),
          candidate.created_at
        )
        db.prepare('INSERT INTO integration_candidate_events VALUES(?,?,?,?)').run(
          randomUUID(),
          candidate.id,
          Date.now(),
          JSON.stringify(candidate)
        )
      })()
    },
    save(candidate: IntegrationCandidate) {
      db.transaction(() => {
        db.prepare('UPDATE integration_candidates SET snapshot=? WHERE id=?').run(
          JSON.stringify({ ...candidate, updated_at: Date.now() }),
          candidate.id
        )
        db.prepare('INSERT INTO integration_candidate_events VALUES(?,?,?,?)').run(
          randomUUID(),
          candidate.id,
          Date.now(),
          JSON.stringify(candidate)
        )
      })()
    },
    all() {
      return decode(db.prepare('SELECT snapshot FROM integration_candidates').all())
    },
  }
}
