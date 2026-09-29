import { createHash } from 'node:crypto'
import { BadRequestError, ConflictError } from './http-errors.js'
import type { Database } from './sqlite.js'

export const createDataRetention = (db: Database) => {
  const preview = (workspaceId: string) =>
    db.transaction(() => {
      const rows = db
        .prepare(
          'SELECT id,status,accepted_at,to_agent_id,report_revision FROM dispatches WHERE workspace_id=? ORDER BY sequence'
        )
        .all(workspaceId) as Array<{
        id: string
        status: string
        accepted_at: number | null
        to_agent_id: string
        report_revision: number
      }>
      const records = rows.map((row) => {
        const reasons: string[] = []
        if (row.status !== 'reported' || row.accepted_at === null)
          reasons.push('terminal_not_confirmed')
        if (
          !db
            .prepare('SELECT 1 FROM report_outbox WHERE dispatch_id=? AND delivered_at IS NOT NULL')
            .get(row.id)
        )
          reasons.push('report_delivery_not_confirmed')
        if (
          db
            .prepare(
              "SELECT 1 FROM message_deliveries WHERE dispatch_id=? AND state NOT IN ('confirmed','resolved')"
            )
            .get(row.id)
        )
          reasons.push('external_action_unresolved')
        if (
          db
            .prepare(
              "SELECT 1 FROM dispatch_verifications WHERE dispatch_id=? AND (state IN ('queued','running') OR accepted_at IS NULL)"
            )
            .get(row.id)
        )
          reasons.push('verification_evidence_unresolved')
        if (
          db
            .prepare(
              'SELECT 1 FROM dispatch_code_reviews WHERE dispatch_id=? AND report_revision=? AND accepted_at IS NULL'
            )
            .get(row.id, row.report_revision)
        )
          reasons.push('review_unresolved')
        if (
          db
            .prepare(
              "SELECT 1 FROM memory_dream_reviews r JOIN memory_dream_runs d ON d.id=r.dream_id WHERE r.dispatch_id=? AND d.status='review'"
            )
            .get(row.id)
        )
          reasons.push('active_dream_reference')
        if (
          db
            .prepare(
              "SELECT 1 FROM memory_sources s JOIN memory_entries m ON m.id=s.memory_id WHERE s.source_type IN ('dispatch','dispatch_message') AND s.source_id=? AND m.status IN ('active','candidate')"
            )
            .get(row.id)
        )
          reasons.push('active_memory_reference')
        if (
          db
            .prepare(
              "SELECT 1 FROM workflow_step_attempts a JOIN workflow_runs w ON w.id=a.run_id WHERE a.dispatch_id=? AND w.status NOT IN ('completed','failed','cancelled')"
            )
            .get(row.id)
        )
          reasons.push('active_workflow_reference')
        const archived = !!db
          .prepare('SELECT 1 FROM dispatch_archives WHERE dispatch_id=?')
          .get(row.id)
        return {
          dispatch_id: row.id,
          report_revision: row.report_revision,
          state: row.status,
          accepted_at: row.accepted_at,
          archived,
          eligible: reasons.length === 0 && !archived,
          reasons,
          attachments: 'retained',
          worktree: 'retained',
        }
      })
      const version = createHash('sha256').update(JSON.stringify(records)).digest('hex')
      return {
        workspace_id: workspaceId,
        version,
        total: rows.length,
        eligible: records.filter((record) => record.eligible).length,
        records,
        mode: 'dry_run',
        physical_bytes_reclaimed: 0,
        permanent_deletion_supported: false,
        worktrees: 'always retained; manual ownership/dirty/integration checks remain required',
      }
    })()
  return {
    preview,
    apply(
      workspaceId: string,
      input: {
        operation_id: string
        expected_version: string
        dispatch_ids: string[]
        action: 'archive' | 'restore'
        confirm: boolean
      }
    ) {
      if (
        !input ||
        input.confirm !== true ||
        !/^[a-f0-9-]{36}$/iu.test(input.operation_id) ||
        !Array.isArray(input.dispatch_ids) ||
        !input.dispatch_ids.length ||
        input.dispatch_ids.length > 1000 ||
        !['archive', 'restore'].includes(input.action)
      )
        throw new BadRequestError(
          'Explicit confirmation, operation ID, action and selected dispatches are required'
        )
      const ids = [...new Set(input.dispatch_ids)].sort()
      return db.transaction(() => {
        const existing = db
          .prepare(
            'SELECT workspace_id,preview_version,receipt_json FROM data_archive_operations WHERE id=?'
          )
          .get(input.operation_id) as
          | { workspace_id: string; preview_version: string; receipt_json: string }
          | undefined
        if (existing) {
          const receipt = JSON.parse(existing.receipt_json)
          if (
            existing.workspace_id !== workspaceId ||
            existing.preview_version !== input.expected_version ||
            receipt.action !== input.action ||
            JSON.stringify(receipt.dispatch_ids) !== JSON.stringify(ids)
          )
            throw new ConflictError('Operation ID belongs to a different request')
          return receipt
        }
        const current = preview(workspaceId)
        if (current.version !== input.expected_version)
          throw new ConflictError('Retention preview changed. Review it again')
        for (const id of ids) {
          const record = current.records.find((row) => row.dispatch_id === id)
          if (!record || (input.action === 'archive' ? !record.eligible : !record.archived))
            throw new ConflictError('Selected record is protected or no longer matches the preview')
        }
        const at = Date.now(),
          receipt = {
            operation_id: input.operation_id,
            action: input.action,
            dispatch_ids: ids,
            completed_at: at,
            physical_bytes_reclaimed: 0,
            files_deleted: 0,
          }
        db.prepare('INSERT INTO data_archive_operations VALUES(?,?,?,?,?)').run(
          input.operation_id,
          workspaceId,
          current.version,
          JSON.stringify(receipt),
          at
        )
        for (const id of ids)
          if (input.action === 'archive')
            db.prepare('INSERT INTO dispatch_archives VALUES(?,?,?)').run(
              id,
              input.operation_id,
              at
            )
          else db.prepare('DELETE FROM dispatch_archives WHERE dispatch_id=?').run(id)
        return receipt
      })()
    },
  }
}
export type DataRetention = ReturnType<typeof createDataRetention>
