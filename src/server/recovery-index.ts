import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { AgentSummary } from '../shared/types.js'
import { BadRequestError, ConflictError } from './http-errors.js'
import { tasksSnapshot } from './tasks-file.js'

export const createRecoveryIndex = (db: Database, readTasks: (path: string) => string) => ({
  page(
    workspaceId: string,
    workspacePath: string,
    actor: Pick<AgentSummary, 'id' | 'name' | 'role'>,
    cursor?: string,
    limit = 25
  ) {
    if ((cursor && cursor.length > 4096) || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestError('limit must be 1–100')
    return db.transaction(() => {
      const tasks = tasksSnapshot(readTasks(workspacePath))
      const scoped = actor.role !== 'orchestrator'
      const dispatches = db
        .prepare(
          `SELECT d.id,d.sequence,d.to_agent_id,d.status,d.text,d.report_revision,d.report_outcome,d.accepted_at FROM dispatches d WHERE d.workspace_id=? ${scoped ? 'AND d.to_agent_id=?' : ''} AND (d.status IN ('queued','submitted','failed') OR EXISTS(SELECT 1 FROM report_outbox o WHERE o.dispatch_id=d.id AND o.delivered_at IS NULL) OR EXISTS(SELECT 1 FROM message_deliveries m WHERE m.dispatch_id=d.id AND m.state IN ('unknown','manual','attempting'))) ORDER BY d.sequence,d.id`
        )
        .all(...(scoped ? [workspaceId, actor.id] : [workspaceId])) as Array<{
        id: string
        status: string
        sequence: number
        text: string
        report_revision: number
      }>
      const items: Array<Record<string, unknown>> = dispatches.map((dispatch) => ({
        kind: 'dispatch',
        ...dispatch,
        next_action:
          dispatch.status === 'reported'
            ? 'reconcile_existing_receipt'
            : dispatch.status === 'failed'
              ? 'manual_reconciliation'
              : 'inspect_before_continue',
        deliveries: db
          .prepare(
            'SELECT id,kind,state,attempt,run_id,session_id,evidence,checkpoint,write_started FROM message_deliveries WHERE dispatch_id=? ORDER BY id'
          )
          .all(dispatch.id),
        outbox: db
          .prepare(
            'SELECT receipt_id,delivery_checkpoint,delivered_at,delivery_attempts FROM report_outbox WHERE dispatch_id=?'
          )
          .all(dispatch.id),
        verifications: db
          .prepare(
            'SELECT id,state,report_revision,head_sha,accepted_at FROM dispatch_verifications WHERE dispatch_id=? ORDER BY id'
          )
          .all(dispatch.id),
        reviews: db
          .prepare(
            'SELECT id,report_revision,conclusion,accepted_at FROM dispatch_code_reviews WHERE dispatch_id=? ORDER BY id'
          )
          .all(dispatch.id),
      }))
      tasks.content.split(/\r?\n/u).forEach((text, index) => {
        if (!/^\s*[-*+]\s+\[ \]/u.test(text)) return
        const owners = [...text.matchAll(/@([^\s]+)/gu)].map((match) => match[1])
        if (scoped && !owners.some((owner) => owner === actor.id || owner === actor.name)) return
        items.push({
          kind: 'task',
          file: '.hive/tasks.md',
          file_version: tasks.version,
          line: index + 1,
          text,
        })
      })
      const snapshot = createHash('sha256')
        .update(
          JSON.stringify({
            workspaceId,
            actorId: actor.id,
            role: actor.role,
            tasksVersion: tasks.version,
            items,
          })
        )
        .digest('hex')
      let offset = 0
      if (cursor) {
        let parsed: unknown
        try {
          parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        } catch {
          throw new BadRequestError('Invalid recovery cursor')
        }
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !('snapshot' in parsed) ||
          !('offset' in parsed) ||
          typeof parsed.offset !== 'number' ||
          !Number.isSafeInteger(parsed.offset) ||
          parsed.offset < 0
        )
          throw new BadRequestError('Invalid recovery cursor')
        if (parsed.snapshot !== snapshot)
          throw Object.assign(
            new ConflictError('Recovery index changed. Reload the first page before continuing.'),
            { code: 'recovery_snapshot_expired' }
          )
        offset = parsed.offset
      }
      if (tasksSnapshot(readTasks(workspacePath)).version !== tasks.version)
        throw Object.assign(
          new ConflictError('Tasks changed while reading recovery context. Reload.'),
          { code: 'recovery_snapshot_expired' }
        )
      const page = items.slice(offset, offset + limit),
        next = offset + page.length
      return {
        snapshot,
        total: items.length,
        remaining: Math.max(0, items.length - next),
        items: page,
        next_cursor:
          next < items.length
            ? Buffer.from(JSON.stringify({ snapshot, offset: next })).toString('base64url')
            : null,
        scope: scoped ? 'own' : 'team',
        tasks_version: tasks.version,
        session_semantics:
          'This index is context for a new session, not a native session identity. Do not redispatch or recreate report receipts.',
      }
    })()
  },
})
export type RecoveryIndex = ReturnType<typeof createRecoveryIndex>
