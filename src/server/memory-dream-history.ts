import { BadRequestError } from './http-errors.js'
import type { Database } from './sqlite.js'
import type { DreamRow } from './team-memory-dream-store.js'

export interface DreamHistoryOptions {
  cursor?: string
  limit?: number
  reviewOnly?: boolean
}

export const parseDreamHistoryQuery = (query: URLSearchParams): DreamHistoryOptions => {
  const limit = query.get('limit')
  const cursor = query.get('cursor')
  const reviewOnly = query.get('review_only')
  if (limit !== null && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50))
    throw new BadRequestError('limit must be an integer between 1 and 50')
  if (cursor !== null && (!cursor.trim() || cursor.length > 200))
    throw new BadRequestError('cursor must be a Dream run id')
  if (reviewOnly !== null && reviewOnly !== 'true' && reviewOnly !== 'false')
    throw new BadRequestError('review_only must be true or false')
  return {
    limit: limit === null ? 20 : Number(limit),
    ...(cursor === null ? {} : { cursor }),
    reviewOnly: reviewOnly === 'true',
  }
}

// The caller holds a read transaction so the cursor, page and count share a snapshot.
export const readDreamHistory = (
  db: Database,
  workspaceId: string,
  { cursor, limit = 20, reviewOnly = false }: DreamHistoryOptions
) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new BadRequestError('limit must be an integer between 1 and 50')
  const conditions = ['workspace_id = ?']
  const bindings: (string | number)[] = [workspaceId]
  if (reviewOnly) conditions.push("plan_version = 1 AND status = 'review'")
  if (cursor !== undefined) {
    const anchor = db
      .prepare('SELECT created_at, id FROM memory_dream_runs WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, cursor) as Pick<DreamRow, 'created_at' | 'id'> | undefined
    if (!anchor) throw new BadRequestError('Dream history cursor was not found in this workspace')
    // A reviewed/discarded cursor remains valid when its status changes between pages.
    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))')
    bindings.push(anchor.created_at, anchor.created_at, anchor.id)
  }
  const rows = db
    .prepare(
      `SELECT * FROM memory_dream_runs WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(...bindings, limit + 1) as DreamRow[]
  const runs = rows.slice(0, limit)
  const count = db
    .prepare(
      "SELECT COUNT(*) AS count FROM memory_dream_runs WHERE workspace_id = ? AND plan_version = 1 AND status = 'review'"
    )
    .get(workspaceId) as { count: number }
  return {
    runs,
    nextCursor: rows.length > limit ? (runs.at(-1)?.id ?? null) : null,
    reviewCount: count.count,
  }
}
