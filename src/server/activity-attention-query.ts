import {
  ATTENTION_KINDS,
  type AttentionItem,
  type AttentionKind,
  type AttentionPage,
} from '../shared/activity-attention.js'
import type { AgentSummary } from '../shared/types.js'
import { BadRequestError } from './http-errors.js'
import type { Database } from './sqlite.js'

// Project existing facts without changing receipts, dispatches or agent state.
const facts = `WITH visible AS (
  SELECT d.* FROM dispatches d WHERE d.workspace_id=@workspace_id
    AND NOT EXISTS(SELECT 1 FROM dispatch_archives a WHERE a.dispatch_id=d.id)
), facts AS (
  SELECT 'question:'||m.id AS id,'question' AS kind,d.workspace_id,d.id AS dispatch_id,
    COALESCE(d.root_dispatch_id,d.id) AS root_dispatch_id,m.to_agent_id AS agent_id,
    substr(d.text,1,500) AS task_text,m.body AS detail,m.created_at AS since,
    'unanswered' AS state,NULL AS delivery_id,m.id AS message_id
  FROM dispatch_messages m JOIN visible d ON d.id=m.dispatch_id
  WHERE m.kind='question' AND d.status IN ('queued','submitted','failed')
    AND NOT EXISTS(SELECT 1 FROM dispatch_messages answer WHERE answer.reply_to=m.id AND answer.kind='answer')
  UNION ALL
  SELECT 'report:'||o.receipt_id,'report_delivery',d.workspace_id,d.id,
    COALESCE(d.root_dispatch_id,d.id),o.target_agent_id,substr(d.text,1,500),
    COALESCE(o.last_delivery_error,m.reason),o.created_at,COALESCE(m.state,'pending'),o.receipt_id,NULL
  FROM report_outbox o JOIN visible d ON d.id=o.dispatch_id
    LEFT JOIN message_deliveries m ON m.id=o.receipt_id
  WHERE o.delivered_at IS NULL
  UNION ALL
  SELECT 'stopped:'||d.id,'stopped_worker',d.workspace_id,d.id,
    COALESCE(d.root_dispatch_id,d.id),d.to_agent_id,substr(d.text,1,500),f.last_error,
    d.created_at,'stopped',NULL,NULL
  FROM visible d LEFT JOIN dispatch_delivery_failures f ON f.dispatch_id=d.id
  WHERE d.status='queued' AND d.to_agent_id IN (SELECT value FROM json_each(@stopped_ids))
  UNION ALL
  SELECT 'acceptance:'||d.id||':'||d.report_revision,'acceptance',d.workspace_id,d.id,
    COALESCE(d.root_dispatch_id,d.id),d.to_agent_id,substr(d.text,1,500),substr(d.report_text,1,1000),
    COALESCE(d.reported_at,d.created_at),'waiting',NULL,NULL
  FROM visible d WHERE d.status='reported' AND d.accepted_at IS NULL
    AND (d.report_outcome IS NULL OR d.report_outcome='success')
  UNION ALL
  SELECT 'remote:connection','remote_connection',w.id,NULL,NULL,NULL,'',NULL,0,@remote_status,NULL,NULL
  FROM workspaces w WHERE w.id=@workspace_id AND @remote_status IS NOT NULL
)`
interface Cursor {
  workspace: string
  filter: string
  until: number
  since: number
  after: string
}
const cursorFrom = (raw: string): Cursor => {
  if (raw.length > 4096) throw new BadRequestError('Attention cursor is too large')
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new BadRequestError('Invalid attention cursor')
    throw error
  }
  if (!value || typeof value !== 'object') throw new BadRequestError('Invalid attention cursor')
  const cursor = value as Cursor
  if (
    typeof cursor.workspace !== 'string' ||
    typeof cursor.filter !== 'string' ||
    typeof cursor.after !== 'string' ||
    !cursor.after ||
    !Number.isSafeInteger(cursor.until) ||
    cursor.until < 0 ||
    !Number.isSafeInteger(cursor.since) ||
    cursor.since < 0 ||
    cursor.since > cursor.until
  )
    throw new BadRequestError('Invalid attention cursor')
  return cursor
}
export const createActivityAttentionQuery = (db: Database) => ({
  page(
    workspaceId: string,
    agents: Pick<AgentSummary, 'id' | 'name' | 'status'>[],
    input: { filter?: string; limit?: number; cursor?: string; remoteStatus?: string | null } = {}
  ): AttentionPage {
    const filter = input.filter ?? 'all',
      limit = input.limit ?? 25
    if (filter !== 'all' && !(ATTENTION_KINDS as readonly string[]).includes(filter))
      throw new BadRequestError('Invalid attention filter')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestError('Attention limit must be between 1 and 100')
    const cursor = input.cursor ? cursorFrom(input.cursor) : null
    if (cursor && (cursor.workspace !== workspaceId || cursor.filter !== filter))
      throw new BadRequestError('Attention cursor belongs to another workspace or filter')
    const until = cursor?.until ?? Date.now()
    const params = {
      workspace_id: workspaceId,
      stopped_ids: JSON.stringify(
        agents.filter((agent) => agent.status === 'stopped').map((agent) => agent.id)
      ),
      remote_status: input.remoteStatus ?? null,
      until,
    }
    return db.transaction(() => {
      const counts: AttentionPage['counts'] = {
        question: 0,
        report_delivery: 0,
        stopped_worker: 0,
        acceptance: 0,
        remote_connection: 0,
      }
      for (const row of db
        .prepare(
          `${facts} SELECT kind,COUNT(*) AS count FROM facts WHERE since<=@until GROUP BY kind`
        )
        .all(params) as Array<{ kind: AttentionKind; count: number }>)
        counts[row.kind] = row.count
      const rows = db
        .prepare(`${facts} SELECT * FROM facts WHERE since<=@until
        AND (@filter='all' OR kind=@filter) AND (since>@since OR (since=@since AND id>@after))
        ORDER BY since,id LIMIT @limit`)
        .all({
          ...params,
          filter,
          since: cursor?.since ?? -1,
          after: cursor?.after ?? '',
          limit: limit + 1,
        }) as Array<Omit<AttentionItem, 'agent_name'> & { since: number }>
      const page = rows.slice(0, limit),
        last = page.at(-1)
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
      const names = new Map(agents.map((agent) => [agent.id, agent.name]))
      return {
        items: page.map((item) => ({
          ...item,
          agent_name: item.agent_id ? (names.get(item.agent_id) ?? item.agent_id) : null,
          since: item.kind === 'remote_connection' ? null : item.since,
        })),
        counts,
        total,
        filtered_total: filter === 'all' ? total : counts[filter as AttentionKind],
        generated_at: Date.now(),
        next_cursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  workspace: workspaceId,
                  filter,
                  until,
                  since: last.since,
                  after: last.id,
                })
              ).toString('base64url')
            : null,
      }
    })()
  },
})
export type ActivityAttentionQuery = ReturnType<typeof createActivityAttentionQuery>
