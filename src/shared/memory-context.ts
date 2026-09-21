export interface MemorySelection {
  memory_id: string
  revision: number
  selected: boolean
  score: number
  reasons: string[]
  hits: Array<{ field: string; token: string }>
  sources: Array<{
    id: string
    source_id: string | null
    type: string
    version: string | null
    captured_version: string | null
    state: 'unknown' | 'current' | 'stale'
    stale?: boolean
  }>
  body?: string
  injected_chars: number
  memory_changed?: boolean
}
export interface MemoryContextSnapshot {
  id: string
  workspace_id: string
  agent_id: string
  context: 'dispatch' | 'startup'
  dispatch_id: string | null
  run_id: string | null
  query: string
  budget: number
  used_chars: number
  digest: string
  candidates: MemorySelection[]
  created_at: number
}
