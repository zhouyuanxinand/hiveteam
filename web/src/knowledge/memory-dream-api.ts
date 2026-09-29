import type { MemoryDreamOperation } from '../../../src/shared/memory-dream-plan.js'
import type {
  TeamMemoryDreamReview,
  TeamMemoryDreamRun,
  TeamMemoryDreamSuggestion,
  TeamMemoryKind,
  TeamMemoryProcedureRef,
  TeamMemoryScope,
} from '../../../src/shared/team-memory.js'
import { apiFetch, readErrorMessage } from '../api.js'

interface TeamMemoryDreamSuggestionPayload {
  body: string
  kind: TeamMemoryKind
  procedure_ref?: TeamMemoryProcedureRef | null
  scope: TeamMemoryScope
  source_memory_ids: string[]
  tags: string[]
}

interface TeamMemoryDreamPayload {
  generation: TeamMemoryDreamRun['generation']
  plan_version: number
  plan_revision: number
  operations: MemoryDreamOperation[]
  source_snapshots: TeamMemoryDreamRun['sourceSnapshots']
  change_receipt: TeamMemoryDreamRun['receipt']
  created_at: number
  created_memory_ids: string[]
  execution_error?: string | null
  execution_status?: TeamMemoryDreamRun['executionStatus']
  id: string
  orchestrator_run_id?: string | null
  rolled_back_at: number | null
  reviews?: TeamMemoryDreamReviewPayload[]
  status: TeamMemoryDreamRun['status']
  submitted_at: number | null
  suggestions: TeamMemoryDreamSuggestionPayload[]
  workspace_id: string
}

interface TeamMemoryDreamReviewPayload {
  artifacts: string[]
  created_at: number
  dispatch_id: string
  dream_id: string
  id: string
  review_text: string | null
  status: TeamMemoryDreamReview['status']
  suggestions: TeamMemoryDreamSuggestionPayload[]
  updated_at: number
  worker_id: string
  workspace_id: string
}

const fromDreamReviewPayload = (payload: TeamMemoryDreamReviewPayload): TeamMemoryDreamReview => ({
  artifacts: payload.artifacts,
  createdAt: payload.created_at,
  dispatchId: payload.dispatch_id,
  dreamId: payload.dream_id,
  id: payload.id,
  reviewText: payload.review_text,
  status: payload.status,
  suggestions: payload.suggestions.map((suggestion) => ({
    body: suggestion.body,
    kind: suggestion.kind,
    procedureRef: suggestion.procedure_ref ?? null,
    scope: suggestion.scope,
    sourceMemoryIds: suggestion.source_memory_ids,
    tags: suggestion.tags,
  })),
  updatedAt: payload.updated_at,
  workerId: payload.worker_id,
  workspaceId: payload.workspace_id,
})

const fromDreamPayload = (payload: TeamMemoryDreamPayload): TeamMemoryDreamRun => ({
  generation: payload.generation ?? null,
  planVersion: payload.plan_version,
  planRevision: payload.plan_revision,
  operations: payload.operations,
  sourceSnapshots: payload.source_snapshots,
  receipt: payload.change_receipt,
  createdAt: payload.created_at,
  createdMemoryIds: payload.created_memory_ids,
  executionError: payload.execution_error ?? null,
  executionStatus: payload.execution_status ?? 'queued',
  id: payload.id,
  orchestratorRunId: payload.orchestrator_run_id ?? null,
  rolledBackAt: payload.rolled_back_at,
  reviews: (payload.reviews ?? []).map(fromDreamReviewPayload),
  status: payload.status,
  submittedAt: payload.submitted_at,
  suggestions: payload.suggestions.map(
    (suggestion): TeamMemoryDreamSuggestion => ({
      body: suggestion.body,
      kind: suggestion.kind,
      procedureRef: suggestion.procedure_ref ?? null,
      scope: suggestion.scope,
      sourceMemoryIds: suggestion.source_memory_ids,
      tags: suggestion.tags,
    })
  ),
  workspaceId: payload.workspace_id,
})

export const listTeamMemoryDreams = async (workspaceId: string): Promise<TeamMemoryDreamRun[]> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/memory/dream`
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to load Dream runs'))
  return ((await response.json()) as TeamMemoryDreamPayload[]).map(fromDreamPayload)
}

export const createTeamMemoryDream = async (workspaceId: string): Promise<TeamMemoryDreamRun> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/memory/dream`,
    {
      method: 'POST',
    }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to prepare Dream review'))
  return fromDreamPayload((await response.json()) as TeamMemoryDreamPayload)
}

export const updateTeamMemoryDream = async (
  workspaceId: string,
  dreamId: string,
  expectedRevision: number,
  operations: MemoryDreamOperation[]
): Promise<TeamMemoryDreamRun> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/memory/dream/${encodeURIComponent(dreamId)}`,
    {
      body: JSON.stringify({ expected_revision: expectedRevision, operations }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
    }
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to save Dream review'))
  return fromDreamPayload((await response.json()) as TeamMemoryDreamPayload)
}

export const submitTeamMemoryDream = async (
  workspaceId: string,
  dreamId: string,
  expectedRevision: number,
  operations: MemoryDreamOperation[]
): Promise<TeamMemoryDreamRun> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/memory/dream/${encodeURIComponent(dreamId)}/submit`,
    {
      body: JSON.stringify({
        orchestrator_id: `${workspaceId}:orchestrator`,
        expected_revision: expectedRevision,
        operations,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Only the Orchestrator can submit Dream'))
  return fromDreamPayload((await response.json()) as TeamMemoryDreamPayload)
}

export const rollbackTeamMemoryDream = async (
  workspaceId: string,
  dreamId: string
): Promise<TeamMemoryDreamRun> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/memory/dream/${encodeURIComponent(dreamId)}/rollback`,
    { method: 'POST' }
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to roll back Dream'))
  return fromDreamPayload((await response.json()) as TeamMemoryDreamPayload)
}

export const listTeamMemoryDreamReviews = async (
  workspaceId: string,
  dreamId: string
): Promise<TeamMemoryDreamReview[]> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/memory/dream/${encodeURIComponent(dreamId)}/reviews`
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to load Dream reviews'))
  return ((await response.json()) as TeamMemoryDreamReviewPayload[]).map(fromDreamReviewPayload)
}

export const requestTeamMemoryDreamReview = async (
  workspaceId: string,
  dreamId: string,
  workerId: string
): Promise<TeamMemoryDreamReview> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/memory/dream/${encodeURIComponent(dreamId)}/reviews`,
    {
      body: JSON.stringify({ worker_id: workerId }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to request Dream review'))
  return fromDreamReviewPayload((await response.json()) as TeamMemoryDreamReviewPayload)
}

export const generateTeamMemoryDream = async (
  workspaceId: string,
  retry = false
): Promise<TeamMemoryDreamRun | null> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/memory/dream/generate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retry }),
    }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to generate memory candidates'))
  if (response.status === 204) return null
  return fromDreamPayload((await response.json()) as TeamMemoryDreamPayload)
}

export const discardTeamMemoryDream = async (
  workspaceId: string,
  dreamId: string,
  expectedRevision: number
): Promise<TeamMemoryDreamRun> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/memory/dream/${encodeURIComponent(dreamId)}/discard`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision }),
    }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to discard memory candidates'))
  return fromDreamPayload((await response.json()) as TeamMemoryDreamPayload)
}

export interface MemoryDreamHistoryPage {
  runs: TeamMemoryDreamRun[]
  nextCursor: string | null
  reviewCount: number
}

export const listTeamMemoryDreamHistory = async (
  workspaceId: string,
  options: { cursor?: string; reviewOnly?: boolean; limit?: number } = {}
): Promise<MemoryDreamHistoryPage> => {
  const query = new URLSearchParams({
    limit: String(options.limit ?? 20),
    review_only: String(options.reviewOnly ?? false),
  })
  if (options.cursor) query.set('cursor', options.cursor)
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/memory/dream/history?${query}`
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to load Dream history'))
  const page = (await response.json()) as {
    runs: TeamMemoryDreamPayload[]
    next_cursor: string | null
    review_count: number
  }
  return {
    runs: page.runs.map(fromDreamPayload),
    nextCursor: page.next_cursor,
    reviewCount: page.review_count,
  }
}

export const getTeamMemoryDream = async (
  workspaceId: string,
  dreamId: string
): Promise<TeamMemoryDreamRun> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/memory/dream/${encodeURIComponent(dreamId)}`
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to refresh Dream generation'))
  return fromDreamPayload((await response.json()) as TeamMemoryDreamPayload)
}
