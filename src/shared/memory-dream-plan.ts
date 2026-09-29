import type { MemoryDreamCursor, MemoryDreamMessage } from './memory-dream-generation.js'
import type { MemorySourceSnapshot } from './memory-provenance.js'
import type {
  TeamMemoryEntry,
  TeamMemoryKind,
  TeamMemoryProcedureRef,
  TeamMemoryScope,
} from './team-memory.js'

export const MEMORY_DREAM_PLAN_VERSION = 1
export const MEMORY_DREAM_MAX_OPERATIONS = 50
export type MemoryDreamAction = 'add' | 'rewrite' | 'merge' | 'archive'
export interface MemoryDreamValue {
  body: string
  kind: TeamMemoryKind
  scope: TeamMemoryScope
  procedure_ref: TeamMemoryProcedureRef | null
  tags: string[]
}
export interface MemoryDreamSnapshot extends MemoryDreamValue {
  memory_id: string
  revision: number
  content_hash: string
  workspace_id: string | null
  pinned: boolean
  disabled: boolean
  status: TeamMemoryEntry['status']
  source: TeamMemoryEntry['source']
  confidence: number
  provenance: MemorySourceSnapshot[]
}
export interface MemoryDreamSourceVersion {
  memory_id: string
  expected_revision: number
  expected_hash: string
}
export interface MemoryDreamOperation {
  message_sources?: number[]
  id: string
  action: MemoryDreamAction
  sources: MemoryDreamSourceVersion[]
  result: MemoryDreamValue | null
}
export interface MemoryDreamChange {
  operation_id: string
  action: MemoryDreamAction
  memory_id: string
  before: MemoryDreamSnapshot | null
  after: MemoryDreamSnapshot
}
export interface MemoryDreamReceipt {
  message_evidence?: {
    input_hash: string
    from: MemoryDreamCursor
    to: MemoryDreamCursor
    messages: MemoryDreamMessage[]
    citations: { operation_id: string; sequences: number[] }[]
  }
  id: string
  dream_id: string
  plan_revision: number
  request_revision: number
  request_hash: string
  actor: { id: string; name: string; role: 'orchestrator' }
  applied_at: number
  rolled_back_at: number | null
  sources: MemoryDreamSnapshot[]
  changes: MemoryDreamChange[]
}
export const memoryDreamImpact = (operations: MemoryDreamOperation[]) => ({
  touched_memory_ids: [
    ...new Set(
      operations
        .filter((operation) => operation.action !== 'add')
        .flatMap((operation) => operation.sources.map((source) => source.memory_id))
    ),
  ],
  created_count: operations.filter(
    (operation) => operation.action === 'add' || operation.action === 'merge'
  ).length,
})
