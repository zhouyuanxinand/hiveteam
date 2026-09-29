import type { CollaborationStatistics } from '../shared/collaboration-stats.js'
import { summarizeDurations } from './collaboration-statistics.js'
import { BadRequestError } from './http-errors.js'
import type { Database } from './sqlite.js'

// Each join below is aggregated before it meets another one-to-many relation.
// Retained archived records remain facts; reading this model never advances work.
const rollup = `WITH families AS (
  SELECT COALESCE(d.root_dispatch_id,d.id) AS root_id,
    MIN(COALESCE(r.created_at,d.created_at)) AS created_at
  FROM dispatches d LEFT JOIN dispatches r
    ON r.id=COALESCE(d.root_dispatch_id,d.id) AND r.workspace_id=d.workspace_id
  WHERE d.workspace_id=? GROUP BY COALESCE(d.root_dispatch_id,d.id)
), cohort AS (
  SELECT d.*, f.root_id FROM dispatches d JOIN families f
    ON f.root_id=COALESCE(d.root_dispatch_id,d.id)
  WHERE d.workspace_id=? AND f.created_at>=? AND f.created_at<?
), task_totals AS (
  SELECT root_id,COUNT(*) AS dispatches,
    SUM(MAX(report_revision - CASE WHEN status='reported' THEN 1 ELSE 0 END,0)) AS reworks,
    CASE WHEN COUNT(*)=COUNT(CASE WHEN submitted_at>=created_at THEN 1 END)
      THEN SUM(submitted_at-created_at) END AS queue_ms,
    CASE WHEN COUNT(*)=COUNT(CASE WHEN status='reported' AND reported_at>=submitted_at THEN 1 END)
      THEN SUM(reported_at-submitted_at) END AS execution_ms
  FROM cohort GROUP BY root_id
), message_totals AS (
  SELECT d.root_id,COUNT(*) AS messages FROM dispatch_messages m
    JOIN cohort d ON d.id=m.dispatch_id GROUP BY d.root_id
), measured AS (
  SELECT p.delivery_id,COUNT(*) AS samples,SUM(p.utf8_bytes) AS bytes
  FROM delivery_payload_measurements p JOIN message_deliveries m ON m.id=p.delivery_id
    JOIN cohort d ON d.id=m.dispatch_id
  GROUP BY p.delivery_id
), receipt_totals AS (
  SELECT d.root_id,SUM(m.attempt) AS attempts,SUM(MAX(m.attempt-1,0)) AS retries,
    SUM(COALESCE(p.samples,0)) AS samples,SUM(COALESCE(p.bytes,0)) AS bytes,
    SUM(CASE WHEN m.attempt=0 AND m.state='pending' THEN 1 ELSE 0 END) AS pending,
    CASE WHEN COUNT(CASE WHEN m.kind='report' THEN 1 END)>0
      AND COUNT(CASE WHEN m.kind='report' THEN 1 END)=
        COUNT(CASE WHEN m.kind='report' AND COALESCE(m.submitted_at,m.confirmed_at)>=m.created_at THEN 1 END)
      THEN SUM(CASE WHEN m.kind='report' THEN COALESCE(m.submitted_at,m.confirmed_at)-m.created_at ELSE 0 END)
    END AS report_ms
  FROM message_deliveries m JOIN cohort d ON d.id=m.dispatch_id
    LEFT JOIN measured p ON p.delivery_id=m.id GROUP BY d.root_id
), integrations AS (
  SELECT d.root_id,v.accepted_at,i.integrated_at
    FROM dispatch_integrations i JOIN dispatch_verifications v ON v.id=i.verification_id
    JOIN cohort d ON d.id=v.dispatch_id AND d.workspace_id=v.workspace_id
  UNION ALL
  SELECT d.root_id,json_extract(c.snapshot,'$.accepted_at'),json_extract(c.snapshot,'$.integrated_at')
    FROM integration_candidates c JOIN cohort d ON d.id=c.dispatch_id AND d.workspace_id=c.workspace_id
    WHERE json_extract(c.snapshot,'$.state')='integrated'
), integration_totals AS (
  SELECT root_id,SUM(integrated_at-accepted_at) AS integration_ms FROM integrations
    WHERE accepted_at IS NOT NULL AND integrated_at>=accepted_at GROUP BY root_id
)
SELECT t.*,COALESCE(m.messages,0) AS messages,
  COALESCE(r.attempts,0) AS attempts,COALESCE(r.retries,0) AS retries,
  COALESCE(r.samples,0) AS samples,COALESCE(r.bytes,0) AS bytes,
  COALESCE(r.pending,0) AS pending,r.report_ms,i.integration_ms
FROM task_totals t LEFT JOIN message_totals m USING(root_id)
  LEFT JOIN receipt_totals r USING(root_id) LEFT JOIN integration_totals i USING(root_id)`

interface RootTotals {
  dispatches: number
  reworks: number
  queue_ms: number | null
  execution_ms: number | null
  messages: number
  attempts: number
  retries: number
  samples: number
  bytes: number
  pending: number
  report_ms: number | null
  integration_ms: number | null
}

export const createCollaborationStatsQuery = (db: Database, now = Date.now) => {
  const query = db.prepare(rollup)
  return {
    read(workspaceId: string, period = '30'): CollaborationStatistics {
      if (period !== '7' && period !== '30' && period !== 'all')
        throw new BadRequestError('Statistics period must be 7, 30 or all')
      const generatedAt = now()
      const since = period === 'all' ? null : generatedAt - Number(period) * 86_400_000
      const rows = query.all(workspaceId, workspaceId, since ?? 0, generatedAt) as RootTotals[]
      const sum = (
        key: keyof Pick<
          RootTotals,
          | 'dispatches'
          | 'reworks'
          | 'messages'
          | 'attempts'
          | 'retries'
          | 'samples'
          | 'bytes'
          | 'pending'
        >
      ) => rows.reduce((total, row) => total + row[key], 0)
      const samples = sum('samples')
      return {
        period,
        since,
        generated_at: generatedAt,
        counts: {
          root_tasks: rows.length,
          dispatches: sum('dispatches'),
          messages: sum('messages'),
          reworks: sum('reworks'),
          delivery_attempts: sum('attempts'),
          retries: sum('retries'),
        },
        durations: {
          queue: summarizeDurations(rows.map((r) => r.queue_ms)),
          execution: summarizeDurations(rows.map((r) => r.execution_ms)),
          report_submission: summarizeDurations(rows.map((r) => r.report_ms)),
          acceptance_to_integration: summarizeDurations(rows.map((r) => r.integration_ms)),
        },
        payload: {
          total_bytes: samples ? sum('bytes') : null,
          measured_attempts: samples,
          unmeasured_attempts: sum('attempts') - samples,
          pending_deliveries: sum('pending'),
        },
      }
    },
  }
}
export type CollaborationStatsQuery = ReturnType<typeof createCollaborationStatsQuery>
