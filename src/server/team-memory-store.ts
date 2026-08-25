import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'

import {
  type CreateTeamMemoryInput,
  TEAM_MEMORY_BODY_MAX_CHARS,
  TEAM_MEMORY_SEARCH_DEFAULT_LIMIT,
  TEAM_MEMORY_SEARCH_MAX_LIMIT,
  type TeamMemoryEntry,
  type TeamMemoryScope,
  type TeamMemoryStatus,
} from '../shared/team-memory.js'

interface TeamMemoryRow {
  body: string
  confidence: number | null
  created_at: number
  created_by_agent_id: string | null
  created_by_agent_name: string | null
  disabled: number
  id: string
  kind: TeamMemoryEntry['kind']
  last_injected_at: number | null
  pinned: number
  scope: TeamMemoryScope
  source: TeamMemoryEntry['source']
  status: TeamMemoryStatus
  tags: string | null
  updated_at: number
  workspace_id: string | null
}

export interface ListTeamMemoryOptions {
  limit?: number
  query?: string
  scope?: TeamMemoryScope
  status?: TeamMemoryStatus
}

export interface UpdateTeamMemoryInput {
  body?: string
  disabled?: boolean
  kind?: TeamMemoryEntry['kind']
  pinned?: boolean
  scope?: TeamMemoryScope
  status?: TeamMemoryStatus
  tags?: string[]
}

const parseTags = (value: string | null): string[] => {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : []
  } catch {
    return []
  }
}

const fromRow = (row: TeamMemoryRow): TeamMemoryEntry => ({
  body: row.body,
  confidence: row.confidence ?? 1,
  createdAt: row.created_at,
  createdByAgentId: row.created_by_agent_id,
  createdByAgentName: row.created_by_agent_name,
  disabled: row.disabled === 1,
  id: row.id,
  kind: row.kind,
  lastInjectedAt: row.last_injected_at,
  pinned: row.pinned === 1,
  scope: row.scope,
  source: row.source,
  status: row.status,
  tags: parseTags(row.tags),
  updatedAt: row.updated_at,
  workspaceId: row.workspace_id,
})

const normalizeBody = (body: string) => {
  const normalized = body.trim()
  if (!normalized) throw new Error('Memory body must not be empty')
  if (normalized.length > TEAM_MEMORY_BODY_MAX_CHARS) {
    throw new Error(`Memory body must be ${TEAM_MEMORY_BODY_MAX_CHARS} characters or fewer`)
  }
  return normalized
}

const normalizeTags = (tags: string[] = []) =>
  [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
    .slice(0, 20)
    .map((tag) => tag.slice(0, 64))

const clampLimit = (limit: number | undefined) =>
  Math.max(1, Math.min(limit ?? TEAM_MEMORY_SEARCH_DEFAULT_LIMIT, TEAM_MEMORY_SEARCH_MAX_LIMIT))

export const createTeamMemoryStore = (db: Database) => {
  const selectEntries = `
    SELECT
      e.*,
      (
        SELECT actor_agent_id_snapshot FROM memory_sources s
        WHERE s.memory_id = e.id ORDER BY s.created_at ASC LIMIT 1
      ) AS created_by_agent_id,
      (
        SELECT actor_name_snapshot FROM memory_sources s
        WHERE s.memory_id = e.id ORDER BY s.created_at ASC LIMIT 1
      ) AS created_by_agent_name
    FROM memory_entries e`
  const get = (workspaceId: string, memoryId: string) => {
    const row = db
      .prepare(
        `${selectEntries}
         WHERE (e.workspace_id = ? OR (e.workspace_id IS NULL AND e.scope = 'user')) AND e.id = ?`
      )
      .get(workspaceId, memoryId) as TeamMemoryRow | undefined
    return row ? fromRow(row) : undefined
  }

  const list = (workspaceId: string, options: ListTeamMemoryOptions = {}) => {
    const clauses = ["(e.workspace_id = ? OR (e.workspace_id IS NULL AND e.scope = 'user'))"]
    const params: Array<number | string> = [workspaceId]
    if (options.status) {
      clauses.push('e.status = ?')
      params.push(options.status)
    }
    if (options.scope) {
      clauses.push('e.scope = ?')
      params.push(options.scope)
    }
    const query = options.query?.trim().toLowerCase()
    if (query) {
      clauses.push('(LOWER(e.body) LIKE ? OR LOWER(e.tags) LIKE ?)')
      params.push(`%${query}%`, `%${query}%`)
    }
    params.push(clampLimit(options.limit))
    const rows = db
      .prepare(
        `${selectEntries}
         WHERE ${clauses.join(' AND ')}
         ORDER BY e.pinned DESC, e.updated_at DESC
         LIMIT ?`
      )
      .all(...params) as TeamMemoryRow[]
    return rows.map(fromRow)
  }

  return {
    create(workspaceId: string, input: CreateTeamMemoryInput) {
      const now = Date.now()
      const entry: TeamMemoryEntry = {
        body: normalizeBody(input.body),
        confidence: Math.max(0, Math.min(input.confidence ?? 1, 1)),
        createdAt: now,
        createdByAgentId: input.createdByAgentId ?? null,
        createdByAgentName: input.createdByAgentName ?? null,
        disabled: false,
        id: randomUUID(),
        kind: input.kind,
        lastInjectedAt: null,
        pinned: false,
        scope: input.scope ?? 'workspace',
        source: input.source ?? 'manual',
        status: input.status ?? 'active',
        tags: normalizeTags(input.tags),
        updatedAt: now,
        workspaceId: input.scope === 'user' ? null : workspaceId,
      }
      db.transaction(() => {
        const ftsRow = db
          .prepare('SELECT COALESCE(MAX(fts_rowid), 0) + 1 AS next_rowid FROM memory_entries')
          .get() as { next_rowid: number }
        db.prepare(
          `INSERT INTO memory_entries (
             id, workspace_id, scope, fts_rowid, kind, body, tags, status, source, confidence,
             pinned, disabled, created_at, updated_at, archived_at, last_injected_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          entry.id,
          entry.workspaceId,
          entry.scope,
          ftsRow.next_rowid,
          entry.kind,
          entry.body,
          JSON.stringify(entry.tags),
          entry.status,
          entry.source,
          entry.confidence,
          0,
          0,
          now,
          now,
          entry.status === 'archived' ? now : null,
          null
        )
        db.prepare(
          `INSERT INTO memory_sources (
             id, memory_id, source_type, actor_agent_id_snapshot,
             actor_name_snapshot, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID(),
          entry.id,
          entry.source,
          entry.createdByAgentId,
          entry.createdByAgentName,
          now
        )
      })()
      return entry
    },
    deleteWorkspaceEntries(workspaceId: string) {
      db.prepare('DELETE FROM memory_injections WHERE workspace_id = ?').run(workspaceId)
      db.prepare(
        'DELETE FROM memory_sources WHERE memory_id IN (SELECT id FROM memory_entries WHERE workspace_id = ?)'
      ).run(workspaceId)
      db.prepare('DELETE FROM memory_entries WHERE workspace_id = ?').run(workspaceId)
    },
    get,
    list,
    listInjectable(workspaceId: string, query: string, limit: number) {
      const pinned = list(workspaceId, { limit, status: 'active' }).filter(
        (entry) => entry.pinned && !entry.disabled
      )
      const merged = new Map<string, TeamMemoryEntry>()
      for (const entry of pinned) merged.set(entry.id, entry)
      const searchTerms = [
        ...new Set(
          query
            .toLowerCase()
            .split(/[^\p{L}\p{N}_-]+/u)
            .map((term) => term.trim())
            .filter((term) => term.length >= 2)
        ),
      ].slice(0, 8)
      for (const term of searchTerms) {
        for (const entry of list(workspaceId, { limit, query: term, status: 'active' })) {
          if (!entry.disabled) merged.set(entry.id, entry)
        }
      }
      if (merged.size === 0) {
        for (const entry of list(workspaceId, { limit, status: 'active' })) {
          if (!entry.disabled) merged.set(entry.id, entry)
        }
      }
      return [...merged.values()].slice(0, clampLimit(limit))
    },
    recordInjection(input: {
      agentId: string
      context: 'dispatch' | 'startup'
      memoryIds: string[]
      query?: string
      workspaceId: string
    }) {
      if (input.memoryIds.length === 0) return
      const now = Date.now()
      db.transaction(() => {
        const insertInjection = db.prepare(
          `INSERT INTO memory_injections (
             id, memory_id, workspace_id, target_agent_id_snapshot,
             context_type, dispatch_id, injected_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        const markInjected = db.prepare(
          `UPDATE memory_entries SET last_injected_at = ?
           WHERE (workspace_id = ? OR (workspace_id IS NULL AND scope = 'user')) AND id = ?`
        )
        for (const memoryId of input.memoryIds) {
          insertInjection.run(
            randomUUID(),
            memoryId,
            input.workspaceId,
            input.agentId,
            input.context,
            null,
            now
          )
          markInjected.run(now, input.workspaceId, memoryId)
        }
      })()
    },
    update(workspaceId: string, memoryId: string, input: UpdateTeamMemoryInput) {
      const current = get(workspaceId, memoryId)
      if (!current) return undefined
      const next = {
        body: input.body === undefined ? current.body : normalizeBody(input.body),
        disabled: input.disabled ?? current.disabled,
        kind: input.kind ?? current.kind,
        pinned: input.pinned ?? current.pinned,
        scope: input.scope ?? current.scope,
        status: input.status ?? current.status,
        tags: input.tags === undefined ? current.tags : normalizeTags(input.tags),
      }
      const updatedAt = Date.now()
      const nextWorkspaceId = next.scope === 'user' ? null : (current.workspaceId ?? workspaceId)
      db.prepare(
        `UPDATE memory_entries
         SET body = ?, disabled = ?, kind = ?, pinned = ?, scope = ?, workspace_id = ?, status = ?, tags = ?,
             updated_at = ?, archived_at = ?
         WHERE (workspace_id = ? OR (workspace_id IS NULL AND scope = 'user')) AND id = ?`
      ).run(
        next.body,
        next.disabled ? 1 : 0,
        next.kind,
        next.pinned ? 1 : 0,
        next.scope,
        nextWorkspaceId,
        next.status,
        JSON.stringify(next.tags),
        updatedAt,
        next.status === 'archived' ? updatedAt : null,
        workspaceId,
        memoryId
      )
      return get(workspaceId, memoryId)
    },
  }
}

export type TeamMemoryStore = ReturnType<typeof createTeamMemoryStore>
