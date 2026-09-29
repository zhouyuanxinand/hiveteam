import type {
  DeliveryCounts,
  DeliveryFilter,
  WorkspaceDeliveryPage,
} from '../shared/workspace-delivery.js'
import type { createDispatchLedgerStore, DispatchRecord } from './dispatch-ledger-store.js'
import { BadRequestError } from './http-errors.js'
import type { Database } from './sqlite.js'

// Read the existing delivery/health facts; this query does not advance their state.
const classified = `WITH classified AS (
  SELECT d.id,d.sequence,d.text,
    CASE WHEN d.status IN ('queued','submitted') THEN 1 ELSE 0 END AS active,
    CASE WHEN d.status='reported' AND d.accepted_at IS NULL
      AND (d.report_outcome IS NULL OR d.report_outcome='success') THEN 1 ELSE 0 END AS waiting,
    CASE WHEN EXISTS(SELECT 1 FROM dispatch_delivery_failures f WHERE f.dispatch_id=d.id)
      OR (d.status='reported' AND d.report_outcome IS NOT NULL AND d.report_outcome<>'success')
      OR EXISTS(SELECT 1 FROM message_deliveries m WHERE m.dispatch_id=d.id AND m.state IN ('unknown','manual'))
      OR EXISTS(SELECT 1 FROM dispatch_health h WHERE h.dispatch_id=d.id
        AND (h.reasons<>'[]' OR h.waiting_reason IN ('waiting_input','waiting_permission','paused')))
      THEN 1 ELSE 0 END AS attention
  FROM dispatches d WHERE d.workspace_id=? AND NOT EXISTS(SELECT 1 FROM dispatch_archives a WHERE a.dispatch_id=d.id)
)`
interface Cursor {
  workspace: string
  filter: DeliveryFilter
  query: string
  snapshot: number
  before: number
}
const decodeCursor = (raw: string): Cursor => {
  if (raw.length > 4096) throw new BadRequestError('Delivery cursor is too large')
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new BadRequestError('Invalid delivery cursor')
    throw error
  }
  if (!value || typeof value !== 'object') throw new BadRequestError('Invalid delivery cursor')
  const cursor = value as Cursor
  if (
    !Number.isSafeInteger(cursor.snapshot) ||
    !Number.isSafeInteger(cursor.before) ||
    cursor.snapshot < 0 ||
    cursor.before <= 0 ||
    cursor.before > cursor.snapshot
  )
    throw new BadRequestError('Invalid delivery cursor position')
  return cursor
}

export const createWorkspaceDeliveryQuery = (
  db: Database,
  ledger: Pick<ReturnType<typeof createDispatchLedgerStore>, 'getDispatchById'>
) => ({
  page(
    workspaceId: string,
    input: { limit?: number; filter?: string; query?: string; cursor?: string } = {}
  ): WorkspaceDeliveryPage<DispatchRecord> {
    const limit = input.limit ?? 25,
      filter = input.filter ?? 'all',
      query = input.query?.trim() ?? ''
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestError('Delivery limit must be between 1 and 100')
    if (!['all', 'active', 'waiting', 'attention'].includes(filter) || query.length > 200)
      throw new BadRequestError('Invalid delivery filter or query')
    const cursor = input.cursor ? decodeCursor(input.cursor) : null
    if (
      cursor &&
      (cursor.workspace !== workspaceId || cursor.filter !== filter || cursor.query !== query)
    )
      throw new BadRequestError('Delivery cursor belongs to a different query')
    return db.transaction(() => {
      const summary = db
        .prepare(`${classified} SELECT COUNT(*) AS total,COALESCE(SUM(active),0) AS active,
        COALESCE(SUM(waiting),0) AS waiting,COALESCE(SUM(attention),0) AS attention FROM classified`)
        .get(workspaceId) as DeliveryCounts
      const snapshot =
        cursor?.snapshot ??
        (
          db
            .prepare(
              'SELECT COALESCE(MAX(sequence),0) AS value FROM dispatches WHERE workspace_id=?'
            )
            .get(workspaceId) as { value: number }
        ).value
      const predicate = `sequence<=? ${filter === 'all' ? '' : `AND ${filter}=1`} AND instr(lower(text),lower(?))>0`
      const filtered = db
        .prepare(`${classified} SELECT COUNT(*) AS count FROM classified WHERE ${predicate}`)
        .get(workspaceId, snapshot, query) as { count: number }
      const rows = db
        .prepare(`${classified} SELECT id,sequence,active,waiting,attention FROM classified
        WHERE ${predicate} ${cursor ? 'AND sequence<?' : ''} ORDER BY sequence DESC,id DESC LIMIT ?`)
        .all(workspaceId, snapshot, query, ...(cursor ? [cursor.before] : []), limit + 1) as Array<{
        id: string
        sequence: number
        active: number
        waiting: number
        attention: number
      }>
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      return {
        items: page.map((row) => {
          const dispatch = ledger.getDispatchById(workspaceId, row.id)
          if (!dispatch) throw new Error('Dispatch disappeared inside a read transaction')
          return {
            ...dispatch,
            delivery_flags: {
              active: !!row.active,
              waiting: !!row.waiting,
              attention: !!row.attention,
            },
          }
        }),
        summary,
        filtered_total: filtered.count,
        snapshot_sequence: snapshot,
        generated_at: Date.now(),
        next_cursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  workspace: workspaceId,
                  filter,
                  query,
                  snapshot,
                  before: last.sequence,
                })
              ).toString('base64url')
            : null,
      }
    })()
  },
})
export type WorkspaceDeliveryQuery = ReturnType<typeof createWorkspaceDeliveryQuery>
