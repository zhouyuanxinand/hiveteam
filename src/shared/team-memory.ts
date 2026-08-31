export const TEAM_MEMORY_BODY_MAX_CHARS = 4_000
export const TEAM_MEMORY_SEARCH_DEFAULT_LIMIT = 10
export const TEAM_MEMORY_SEARCH_MAX_LIMIT = 50
export const TEAM_MEMORY_PROCEDURE_REF_ID_MAX_CHARS = 256
export const TEAM_MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS = 160

export const teamMemoryKinds = [
  'fact',
  'preference',
  'decision',
  'pitfall',
  'procedure_ref',
] as const
export const teamMemoryScopes = ['workspace', 'user'] as const
export const teamMemoryStatuses = ['active', 'candidate', 'archived', 'rejected'] as const
export const teamMemorySources = ['manual', 'dream'] as const
export const teamMemoryProcedureRefTypes = [
  'workflow',
  'skill',
  'procedure',
  'template',
  'doc',
] as const

export type TeamMemoryKind = (typeof teamMemoryKinds)[number]
export type TeamMemoryScope = (typeof teamMemoryScopes)[number]
export type TeamMemoryStatus = (typeof teamMemoryStatuses)[number]
export type TeamMemorySource = (typeof teamMemorySources)[number]
export type TeamMemoryProcedureRefType = (typeof teamMemoryProcedureRefTypes)[number]

export interface TeamMemoryProcedureRef {
  id: string
  title: string | null
  type: TeamMemoryProcedureRefType
}

export interface TeamMemoryEntry {
  body: string
  confidence: number
  createdAt: number
  createdByAgentId: string | null
  createdByAgentName: string | null
  disabled: boolean
  id: string
  kind: TeamMemoryKind
  lastInjectedAt: number | null
  pinned: boolean
  procedureRef: TeamMemoryProcedureRef | null
  scope: TeamMemoryScope
  source: TeamMemorySource
  status: TeamMemoryStatus
  tags: string[]
  updatedAt: number
  workspaceId: string | null
}

export interface CreateTeamMemoryInput {
  body: string
  confidence?: number
  createdByAgentId?: string | null
  createdByAgentName?: string | null
  kind: TeamMemoryKind
  procedureRef?: TeamMemoryProcedureRef | null
  scope?: TeamMemoryScope
  source?: TeamMemorySource
  status?: TeamMemoryStatus
  tags?: string[]
}

export type TeamMemoryDreamStatus = 'review' | 'submitted' | 'rolled_back'

export type TeamMemoryDreamExecutionStatus = 'queued' | 'requested' | 'completed' | 'failed'

export type TeamMemoryDreamReviewStatus = 'queued' | 'completed' | 'failed'

export interface TeamMemoryDreamSuggestion {
  body: string
  kind: TeamMemoryKind
  procedureRef: TeamMemoryProcedureRef | null
  scope: TeamMemoryScope
  sourceMemoryIds: string[]
  tags: string[]
}

export interface TeamMemoryDreamRun {
  createdAt: number
  createdMemoryIds: string[]
  executionError: string | null
  executionStatus: TeamMemoryDreamExecutionStatus
  id: string
  orchestratorRunId: string | null
  rolledBackAt: number | null
  status: TeamMemoryDreamStatus
  submittedAt: number | null
  reviews: TeamMemoryDreamReview[]
  suggestions: TeamMemoryDreamSuggestion[]
  workspaceId: string
}

export interface TeamMemoryDreamReview {
  artifacts: string[]
  createdAt: number
  dispatchId: string
  dreamId: string
  id: string
  reviewText: string | null
  status: TeamMemoryDreamReviewStatus
  suggestions: TeamMemoryDreamSuggestion[]
  updatedAt: number
  workerId: string
  workspaceId: string
}

export const isTeamMemoryKind = (value: unknown): value is TeamMemoryKind =>
  typeof value === 'string' && (teamMemoryKinds as readonly string[]).includes(value)

export const isTeamMemoryScope = (value: unknown): value is TeamMemoryScope =>
  typeof value === 'string' && (teamMemoryScopes as readonly string[]).includes(value)

export const isTeamMemoryStatus = (value: unknown): value is TeamMemoryStatus =>
  typeof value === 'string' && (teamMemoryStatuses as readonly string[]).includes(value)

export const isTeamMemoryProcedureRefType = (value: unknown): value is TeamMemoryProcedureRefType =>
  typeof value === 'string' && (teamMemoryProcedureRefTypes as readonly string[]).includes(value)

/**
 * Coerce a reference to the one persisted form shared by HTTP, Dream, and
 * direct store callers. This intentionally validates only the documented
 * reference vocabulary: a reference ID can point to a local workflow, skill,
 * procedure, template, or document without making the memory subsystem read
 * arbitrary files.
 */
export const normalizeTeamMemoryProcedureRef = (value: unknown): TeamMemoryProcedureRef | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('procedure_ref must be an object')
  }

  const record = value as Record<string, unknown>
  if (!isTeamMemoryProcedureRefType(record.type)) {
    throw new Error(`procedure_ref.type must be one of: ${teamMemoryProcedureRefTypes.join(', ')}`)
  }
  if (typeof record.id !== 'string' || !record.id.trim()) {
    throw new Error('procedure_ref.id must be a non-empty string')
  }

  const id = record.id.trim()
  if ([...id].length > TEAM_MEMORY_PROCEDURE_REF_ID_MAX_CHARS) {
    throw new Error(
      `procedure_ref.id must be ${TEAM_MEMORY_PROCEDURE_REF_ID_MAX_CHARS} characters or fewer`
    )
  }
  if (record.title !== undefined && record.title !== null && typeof record.title !== 'string') {
    throw new Error('procedure_ref.title must be a string')
  }

  const title = typeof record.title === 'string' ? record.title.trim() || null : null
  if (title !== null && [...title].length > TEAM_MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS) {
    throw new Error(
      `procedure_ref.title must be ${TEAM_MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS} characters or fewer`
    )
  }

  return { id, title, type: record.type }
}
