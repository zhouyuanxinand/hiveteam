import type { Database } from 'better-sqlite3'
import type { DeliveryQueueState } from '../shared/delivery-queue.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'

const query = `WITH queue AS (
  SELECT d.id, d.workspace_id AS workspaceId, w.name AS workspaceName,
    COALESCE(a.name, d.to_agent_id) AS workerName, d.created_at AS createdAt, d.sequence,
    CASE
      WHEN d.status = 'cancelled' THEN NULL
      WHEN f.dispatch_id IS NOT NULL OR d.status = 'failed' OR d.report_outcome IN ('blocked', 'failed', 'partial') THEN 'blocked'
      WHEN d.status <> 'reported' THEN NULL
      WHEN u.state IN ('running', 'conflicted', 'failed') THEN 'blocked'
      WHEN v.id IS NULL OR v.report_revision <> d.report_revision THEN 'verify'
      WHEN u.state = 'complete' AND v.head_sha = u.source_sha THEN 'verify'
      WHEN v.state = 'running' THEN NULL
      WHEN v.state <> 'passed' THEN 'verification_failed'
      WHEN v.accepted_at IS NULL OR d.accepted_at IS NULL THEN 'review'
      WHEN p.dispatch_id IS NOT NULL AND (p.verification_id <> v.id OR p.head_sha <> v.head_sha) THEN 'pull_request'
      WHEN p.state = 'publishing' THEN 'publishing'
      WHEN p.state = 'failed' OR p.error IS NOT NULL THEN 'publish_failed'
      WHEN p.dispatch_id IS NOT NULL AND (p.snapshot IS NULL OR json_extract(p.snapshot, '$.headSha') <> p.head_sha) THEN 'pull_request'
      WHEN json_extract(p.snapshot, '$.state') = 'merged' THEN NULL
      WHEN json_extract(p.snapshot, '$.ciState') = 'failed' THEN 'ci_failed'
      WHEN p.dispatch_id IS NOT NULL THEN 'pull_request'
      WHEN t.worker_id IS NOT NULL AND i.verification_id IS NULL THEN 'integrate'
      ELSE NULL
    END AS state,
    json_extract(p.snapshot, '$.checkedAt') AS checkedAt
  FROM dispatches d JOIN workspaces w ON w.id = d.workspace_id
  LEFT JOIN workers a ON a.id = d.to_agent_id AND a.workspace_id = d.workspace_id
  LEFT JOIN dispatch_delivery_failures f ON f.dispatch_id = d.id
  LEFT JOIN dispatch_verifications v ON v.id = (
    SELECT id FROM dispatch_verifications WHERE dispatch_id = d.id ORDER BY started_at DESC, rowid DESC LIMIT 1
  )
  LEFT JOIN worker_worktrees t ON t.worker_id = d.to_agent_id AND t.workspace_id = d.workspace_id
  LEFT JOIN worker_branch_updates u ON u.worker_id = t.worker_id
  LEFT JOIN dispatch_integrations i ON i.verification_id = v.id
  LEFT JOIN dispatch_pull_requests p ON p.dispatch_id = d.id
)
`
interface Row {
  id: string
  workspaceId: string
  workspaceName: string
  workerName: string
  createdAt: number
  state: DeliveryQueueState
  checkedAt: number | null
}
export const createDeliveryQueueStore = (
  db: Database,
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
) => ({
  list(input: { limit: number; offset: number; workspaceId?: string; state?: DeliveryQueueState }) {
    const where =
      ' WHERE state IS NOT NULL' +
      (input.workspaceId ? ' AND workspaceId = @workspaceId' : '') +
      (input.state ? ' AND state = @state' : '')
    return db.transaction(() => {
      const counts = db
        .prepare(`${query}SELECT state, COUNT(*) AS count FROM queue${where} GROUP BY state`)
        .all(input) as Array<{ state: DeliveryQueueState; count: number }>
      const rows = db
        .prepare(
          query +
            'SELECT * FROM queue' +
            where +
            ` ORDER BY
        CASE state WHEN 'blocked' THEN 0 WHEN 'ci_failed' THEN 1 WHEN 'publish_failed' THEN 2
          WHEN 'verification_failed' THEN 3 ELSE 4 END, createdAt ASC, sequence ASC
        LIMIT @limit OFFSET @offset`
        )
        .all(input) as Row[]
      return {
        total: counts.reduce((sum, row) => sum + row.count, 0),
        counts: Object.fromEntries(counts.map((row) => [row.state, row.count])),
        limit: input.limit,
        offset: input.offset,
        items: rows.map((row) => {
          const dispatch = getDispatch(row.workspaceId, row.id)
          if (!dispatch)
            throw new Error(`Queue dispatch ${row.id} is missing from its database snapshot`)
          return { ...row, dispatch }
        }),
      }
    })()
  },
})
export type DeliveryQueueStore = ReturnType<typeof createDeliveryQueueStore>
