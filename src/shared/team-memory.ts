export const TEAM_MEMORY_BODY_MAX_CHARS = 4_000
export const TEAM_MEMORY_SEARCH_DEFAULT_LIMIT = 10
export const TEAM_MEMORY_SEARCH_MAX_LIMIT = 50

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

export type TeamMemoryKind = (typeof teamMemoryKinds)[number]
export type TeamMemoryScope = (typeof teamMemoryScopes)[number]
export type TeamMemoryStatus = (typeof teamMemoryStatuses)[number]
export type TeamMemorySource = (typeof teamMemorySources)[number]

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
  scope?: TeamMemoryScope
  source?: TeamMemorySource
  status?: TeamMemoryStatus
  tags?: string[]
}

export const isTeamMemoryKind = (value: unknown): value is TeamMemoryKind =>
  typeof value === 'string' && (teamMemoryKinds as readonly string[]).includes(value)

export const isTeamMemoryScope = (value: unknown): value is TeamMemoryScope =>
  typeof value === 'string' && (teamMemoryScopes as readonly string[]).includes(value)

export const isTeamMemoryStatus = (value: unknown): value is TeamMemoryStatus =>
  typeof value === 'string' && (teamMemoryStatuses as readonly string[]).includes(value)
