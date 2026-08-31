import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import type {
  TeamMemoryDreamReview,
  TeamMemoryDreamRun,
  TeamMemoryDreamStatus,
  TeamMemoryDreamSuggestion,
  TeamMemoryEntry,
  TeamMemoryKind,
  TeamMemoryProcedureRef,
  TeamMemoryScope,
} from '../shared/team-memory.js'
import {
  isTeamMemoryKind,
  isTeamMemoryScope,
  normalizeTeamMemoryProcedureRef,
} from '../shared/team-memory.js'
import { sanitizePromptData } from './prompt-safety.js'
import type { TeamMemoryStore, UpdateTeamMemoryInput } from './team-memory-store.js'

interface DreamSourceSnapshot {
  body: string
  disabled: boolean
  id: string
  kind: TeamMemoryKind
  pinned: boolean
  procedureRef: TeamMemoryProcedureRef | null
  scope: TeamMemoryScope
  status: TeamMemoryEntry['status']
  tags: string[]
}

interface DreamRow {
  created_at: number
  created_memory_ids_json: string
  execution_error: string | null
  execution_status: TeamMemoryDreamRun['executionStatus']
  id: string
  orchestrator_run_id: string | null
  rolled_back_at: number | null
  source_snapshots_json: string
  status: TeamMemoryDreamStatus
  submitted_at: number | null
  suggestions_json: string
  updated_at: number
  workspace_id: string
}

interface DreamReviewRow {
  artifacts_json: string
  created_at: number
  dispatch_id: string
  dream_id: string
  id: string
  review_text: string | null
  status: TeamMemoryDreamReview['status']
  suggestions_json: string
  updated_at: number
  worker_id: string
  workspace_id: string
}

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const normalizeStoredProcedureRef = (value: unknown): TeamMemoryProcedureRef | null => {
  try {
    return normalizeTeamMemoryProcedureRef(value)
  } catch {
    // A pre-validation Dream record must remain readable. Invalid legacy data
    // is rejected before it can be submitted instead of breaking the drawer.
    return null
  }
}

const normalizeSuggestion = (suggestion: TeamMemoryDreamSuggestion): TeamMemoryDreamSuggestion => ({
  body: sanitizePromptData(suggestion.body, 4_000).trim(),
  kind: suggestion.kind,
  procedureRef: normalizeStoredProcedureRef(suggestion.procedureRef),
  scope: suggestion.scope,
  sourceMemoryIds: [...new Set(suggestion.sourceMemoryIds)].slice(0, 50),
  tags: [...new Set(suggestion.tags.map((tag) => tag.trim()).filter(Boolean))]
    .slice(0, 20)
    .map((tag) => tag.slice(0, 64)),
})

const normalizeSnapshot = (snapshot: DreamSourceSnapshot): DreamSourceSnapshot => ({
  ...snapshot,
  procedureRef: normalizeStoredProcedureRef(snapshot.procedureRef),
})

const requireProcedureReferences = (suggestions: TeamMemoryDreamSuggestion[]) => {
  if (
    suggestions.some(
      (suggestion) => suggestion.kind === 'procedure_ref' && !suggestion.procedureRef
    )
  ) {
    throw new Error('procedure_ref Dream suggestions require a procedure_ref')
  }
}

const fromRow = (row: DreamRow): TeamMemoryDreamRun => ({
  createdAt: row.created_at,
  createdMemoryIds: parseJson<string[]>(row.created_memory_ids_json, []),
  executionError: row.execution_error,
  executionStatus: row.execution_status,
  id: row.id,
  orchestratorRunId: row.orchestrator_run_id,
  rolledBackAt: row.rolled_back_at,
  reviews: [],
  status: row.status,
  submittedAt: row.submitted_at,
  suggestions: parseJson<TeamMemoryDreamSuggestion[]>(row.suggestions_json, []).map(
    normalizeSuggestion
  ),
  workspaceId: row.workspace_id,
})

const fromReviewRow = (row: DreamReviewRow): TeamMemoryDreamReview => ({
  artifacts: parseJson<string[]>(row.artifacts_json, [])
    .filter((artifact): artifact is string => typeof artifact === 'string')
    .map((artifact) => sanitizePromptData(artifact, 1_000)),
  createdAt: row.created_at,
  dispatchId: row.dispatch_id,
  dreamId: row.dream_id,
  id: row.id,
  reviewText: row.review_text ? sanitizePromptData(row.review_text, 8_000) : null,
  status: row.status,
  suggestions: parseJson<TeamMemoryDreamSuggestion[]>(row.suggestions_json, [])
    .filter((suggestion): suggestion is TeamMemoryDreamSuggestion =>
      Boolean(
        suggestion &&
          typeof suggestion === 'object' &&
          typeof suggestion.body === 'string' &&
          isTeamMemoryKind(suggestion.kind) &&
          isTeamMemoryScope(suggestion.scope) &&
          Array.isArray(suggestion.sourceMemoryIds) &&
          Array.isArray(suggestion.tags)
      )
    )
    .map(normalizeSuggestion),
  updatedAt: row.updated_at,
  workerId: row.worker_id,
  workspaceId: row.workspace_id,
})

const parseReviewSuggestions = (text: string): TeamMemoryDreamSuggestion[] => {
  const markerIndex = text.indexOf('DREAM_REVIEW_JSON')
  if (markerIndex < 0) return []
  const candidate = text.slice(markerIndex + 'DREAM_REVIEW_JSON'.length).match(/\{[\s\S]*\}/)?.[0]
  if (!candidate) return []
  try {
    const parsed = JSON.parse(candidate) as { suggestions?: unknown }
    if (!Array.isArray(parsed.suggestions)) return []
    return parsed.suggestions
      .filter((suggestion): suggestion is Record<string, unknown> => {
        if (!suggestion || typeof suggestion !== 'object') return false
        const value = suggestion as Record<string, unknown>
        return (
          typeof value.body === 'string' &&
          value.body.trim().length > 0 &&
          isTeamMemoryKind(value.kind) &&
          isTeamMemoryScope(value.scope)
        )
      })
      .map((suggestion) =>
        normalizeSuggestion({
          body: suggestion.body as string,
          kind: suggestion.kind as TeamMemoryKind,
          procedureRef: normalizeStoredProcedureRef(suggestion.procedure_ref),
          scope: suggestion.scope as TeamMemoryScope,
          sourceMemoryIds: Array.isArray(suggestion.source_memory_ids)
            ? suggestion.source_memory_ids.filter((id): id is string => typeof id === 'string')
            : [],
          tags: Array.isArray(suggestion.tags)
            ? suggestion.tags.filter((tag): tag is string => typeof tag === 'string')
            : [],
        })
      )
      .filter((suggestion) => suggestion.body)
      .slice(0, 20)
  } catch {
    return []
  }
}

const createSuggestions = (entries: TeamMemoryEntry[]): TeamMemoryDreamSuggestion[] => {
  const groups = new Map<string, TeamMemoryEntry[]>()
  for (const entry of entries) {
    if (entry.disabled || entry.status !== 'active') continue
    if (entry.kind === 'procedure_ref' && !entry.procedureRef) continue
    const key =
      entry.kind === 'procedure_ref'
        ? `${entry.kind}\u0000${entry.procedureRef?.type ?? ''}\u0000${entry.procedureRef?.id ?? ''}`
        : entry.kind
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .map(([, group]) => ({
      body:
        group.length === 1
          ? (group[0]?.body ?? '')
          : group.map((entry) => `- ${entry.body}`).join('\n'),
      kind: group[0]?.kind ?? 'fact',
      procedureRef: group[0]?.procedureRef ?? null,
      scope: 'workspace' as const,
      sourceMemoryIds: group.map((entry) => entry.id),
      tags: [...new Set(group.flatMap((entry) => entry.tags))].slice(0, 20),
    }))
    .filter((suggestion) => suggestion.body.trim())
}

export const createTeamMemoryDreamStore = (db: Database, memory: TeamMemoryStore) => {
  const get = (workspaceId: string, dreamId: string) => {
    const row = db
      .prepare('SELECT * FROM memory_dream_runs WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, dreamId) as DreamRow | undefined
    return row ? fromRow(row) : undefined
  }

  const list = (workspaceId: string, limit = 20) =>
    (
      db
        .prepare(
          `SELECT * FROM memory_dream_runs
         WHERE workspace_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
        )
        .all(workspaceId, Math.max(1, Math.min(50, Math.floor(limit)))) as DreamRow[]
    ).map(fromRow)

  const getSnapshots = (workspaceId: string, dreamId: string) => {
    const row = db
      .prepare(
        'SELECT source_snapshots_json FROM memory_dream_runs WHERE workspace_id = ? AND id = ?'
      )
      .get(workspaceId, dreamId) as { source_snapshots_json: string } | undefined
    return row
      ? parseJson<DreamSourceSnapshot[]>(row.source_snapshots_json, []).map(normalizeSnapshot)
      : []
  }

  return {
    create(workspaceId: string) {
      const entries = memory.list(workspaceId, { limit: 50, status: 'active' })
      const suggestions = createSuggestions(entries)
      const snapshots: DreamSourceSnapshot[] = entries
        .filter((entry) =>
          suggestions.some((suggestion) => suggestion.sourceMemoryIds.includes(entry.id))
        )
        .map((entry) => ({
          body: entry.body,
          disabled: entry.disabled,
          id: entry.id,
          kind: entry.kind,
          pinned: entry.pinned,
          procedureRef: entry.procedureRef,
          scope: entry.scope,
          status: entry.status,
          tags: entry.tags,
        }))
      const now = Date.now()
      const id = randomUUID()
      db.prepare(
        `INSERT INTO memory_dream_runs (
           id, workspace_id, status, suggestions_json, source_snapshots_json,
           created_memory_ids_json, created_at, submitted_at, rolled_back_at, updated_at,
           execution_status, orchestrator_run_id, execution_error
         ) VALUES (?, ?, 'review', ?, ?, '[]', ?, NULL, NULL, ?, 'queued', NULL, NULL)`
      ).run(id, workspaceId, JSON.stringify(suggestions), JSON.stringify(snapshots), now, now)
      return get(workspaceId, id) as TeamMemoryDreamRun
    },
    get,
    list,
    listPendingExecution(workspaceId: string) {
      return (
        db
          .prepare(
            `SELECT * FROM memory_dream_runs
             WHERE workspace_id = ? AND status = 'review'
               AND execution_status IN ('queued', 'failed')
             ORDER BY created_at ASC`
          )
          .all(workspaceId) as DreamRow[]
      ).map(fromRow)
    },
    markExecutionRequested(workspaceId: string, dreamId: string, orchestratorRunId: string) {
      db.prepare(
        `UPDATE memory_dream_runs
         SET execution_status = 'requested', orchestrator_run_id = ?, execution_error = NULL,
             updated_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'review'`
      ).run(orchestratorRunId, Date.now(), workspaceId, dreamId)
      return get(workspaceId, dreamId)
    },
    markExecutionFailed(workspaceId: string, dreamId: string, error: string) {
      db.prepare(
        `UPDATE memory_dream_runs
         SET execution_status = 'failed', execution_error = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'review'`
      ).run(sanitizePromptData(error, 1_000), Date.now(), workspaceId, dreamId)
      return get(workspaceId, dreamId)
    },
    markExecutionCompleted(workspaceId: string, dreamId: string) {
      db.prepare(
        `UPDATE memory_dream_runs
         SET execution_status = 'completed', execution_error = NULL, updated_at = ?
         WHERE workspace_id = ? AND id = ?`
      ).run(Date.now(), workspaceId, dreamId)
      return get(workspaceId, dreamId)
    },
    recordReviewRequest(
      workspaceId: string,
      dreamId: string,
      workerId: string,
      dispatchId: string
    ) {
      const now = Date.now()
      const id = randomUUID()
      db.prepare(
        `INSERT INTO memory_dream_reviews (
           id, workspace_id, dream_id, worker_id, dispatch_id, status,
           review_text, suggestions_json, artifacts_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, '[]', '[]', ?, ?)`
      ).run(id, workspaceId, dreamId, workerId, dispatchId, now, now)
      return fromReviewRow(
        db
          .prepare('SELECT * FROM memory_dream_reviews WHERE workspace_id = ? AND id = ?')
          .get(workspaceId, id) as DreamReviewRow
      )
    },
    markReviewFailed(workspaceId: string, dispatchId: string) {
      db.prepare(
        `UPDATE memory_dream_reviews
         SET status = 'failed', updated_at = ?
         WHERE workspace_id = ? AND dispatch_id = ? AND status = 'queued'`
      ).run(Date.now(), workspaceId, dispatchId)
      const row = db
        .prepare('SELECT * FROM memory_dream_reviews WHERE workspace_id = ? AND dispatch_id = ?')
        .get(workspaceId, dispatchId) as DreamReviewRow | undefined
      return row ? fromReviewRow(row) : undefined
    },
    listReviews(workspaceId: string, dreamId: string) {
      return (
        db
          .prepare(
            `SELECT * FROM memory_dream_reviews
             WHERE workspace_id = ? AND dream_id = ?
             ORDER BY created_at DESC`
          )
          .all(workspaceId, dreamId) as DreamReviewRow[]
      ).map(fromReviewRow)
    },
    recordWorkerReview(
      workspaceId: string,
      dispatchId: string,
      reviewText: string,
      artifacts: string[]
    ) {
      const row = db
        .prepare('SELECT * FROM memory_dream_reviews WHERE workspace_id = ? AND dispatch_id = ?')
        .get(workspaceId, dispatchId) as DreamReviewRow | undefined
      if (!row) return undefined
      const now = Date.now()
      db.prepare(
        `UPDATE memory_dream_reviews
         SET status = 'completed', review_text = ?, suggestions_json = ?, artifacts_json = ?,
             updated_at = ?
         WHERE workspace_id = ? AND dispatch_id = ?`
      ).run(
        sanitizePromptData(reviewText, 8_000),
        JSON.stringify(parseReviewSuggestions(reviewText)),
        JSON.stringify(
          artifacts.map((artifact) => sanitizePromptData(artifact, 1_000)).slice(0, 20)
        ),
        now,
        workspaceId,
        dispatchId
      )
      return fromReviewRow(
        db
          .prepare('SELECT * FROM memory_dream_reviews WHERE workspace_id = ? AND dispatch_id = ?')
          .get(workspaceId, dispatchId) as DreamReviewRow
      )
    },
    updateSuggestions(
      workspaceId: string,
      dreamId: string,
      suggestions: TeamMemoryDreamSuggestion[]
    ) {
      const current = get(workspaceId, dreamId)
      if (!current) return undefined
      if (current.status !== 'review') throw new Error('Only a Dream in review can be edited')
      const normalized = suggestions
        .map(normalizeSuggestion)
        .filter((suggestion) => suggestion.body)
      requireProcedureReferences(normalized)
      db.prepare(
        'UPDATE memory_dream_runs SET suggestions_json = ?, updated_at = ? WHERE workspace_id = ? AND id = ?'
      ).run(JSON.stringify(normalized), Date.now(), workspaceId, dreamId)
      return get(workspaceId, dreamId)
    },
    submit(workspaceId: string, dreamId: string, actor: { id: string; name: string }) {
      const current = get(workspaceId, dreamId)
      if (!current) return undefined
      if (current.status !== 'review') throw new Error('This Dream has already been submitted')
      requireProcedureReferences(current.suggestions)
      const snapshots = getSnapshots(workspaceId, dreamId)
      const createdIds: string[] = []
      const now = Date.now()
      db.transaction(() => {
        for (const snapshot of snapshots) {
          memory.update(workspaceId, snapshot.id, {
            status: 'archived',
          })
        }
        for (const suggestion of current.suggestions) {
          const created = memory.create(workspaceId, {
            body: suggestion.body,
            createdByAgentId: actor.id,
            createdByAgentName: actor.name,
            kind: suggestion.kind,
            procedureRef: suggestion.procedureRef,
            scope: suggestion.scope,
            source: 'dream',
            status: 'active',
            tags: suggestion.tags,
          })
          createdIds.push(created.id)
        }
        db.prepare(
          `UPDATE memory_dream_runs
           SET status = 'submitted', created_memory_ids_json = ?, submitted_at = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?`
        ).run(JSON.stringify(createdIds), now, now, workspaceId, dreamId)
        db.prepare(
          `UPDATE memory_dream_runs
           SET execution_status = 'completed', execution_error = NULL, updated_at = ?
           WHERE workspace_id = ? AND id = ?`
        ).run(now, workspaceId, dreamId)
      })()
      return get(workspaceId, dreamId)
    },
    rollback(workspaceId: string, dreamId: string) {
      const current = get(workspaceId, dreamId)
      if (!current) return undefined
      if (current.status === 'rolled_back') return current
      if (current.status !== 'submitted')
        throw new Error('Only a submitted Dream can be rolled back')
      const snapshots = getSnapshots(workspaceId, dreamId)
      const restore = (snapshot: DreamSourceSnapshot): UpdateTeamMemoryInput => ({
        body: snapshot.body,
        disabled: snapshot.disabled,
        kind: snapshot.kind,
        pinned: snapshot.pinned,
        procedureRef: snapshot.procedureRef,
        scope: snapshot.scope,
        status: snapshot.status,
        tags: snapshot.tags,
      })
      const now = Date.now()
      db.transaction(() => {
        for (const snapshot of snapshots) memory.update(workspaceId, snapshot.id, restore(snapshot))
        for (const memoryId of current.createdMemoryIds) {
          memory.update(workspaceId, memoryId, { status: 'archived', disabled: true })
        }
        db.prepare(
          `UPDATE memory_dream_runs
           SET status = 'rolled_back', rolled_back_at = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?`
        ).run(now, now, workspaceId, dreamId)
      })()
      return get(workspaceId, dreamId)
    },
    deleteWorkspace(workspaceId: string) {
      db.prepare('DELETE FROM memory_dream_reviews WHERE workspace_id = ?').run(workspaceId)
      db.prepare('DELETE FROM memory_dream_runs WHERE workspace_id = ?').run(workspaceId)
    },
  }
}

export type TeamMemoryDreamStore = ReturnType<typeof createTeamMemoryDreamStore>
