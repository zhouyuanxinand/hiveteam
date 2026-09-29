import type { MemoryDreamSnapshot } from './memory-dream-plan.js'

export interface MemoryDreamCursor {
  sequence: number
  offset: number
  source_hash?: string | null
}
export interface MemoryDreamMessage {
  sequence: number
  type: string
  created_at: number
  from_agent_id: string | null
  to_agent_id: string | null
  text: string
  start_offset: number
  end_offset: number
  total_chars: number
  content_hash: string
}
export interface MemoryDreamGeneration {
  status: 'pending' | 'requested' | 'failed' | 'completed'
  attempt_id: string | null
  run_id: string | null
  requested_at: number | null
  completed_at: number | null
  error: string | null
  input_hash: string
  candidate_count: number | null
  result_summary: string | null
  input: {
    from: MemoryDreamCursor
    to: MemoryDreamCursor
    messages: MemoryDreamMessage[]
    memories: MemoryDreamSnapshot[]
  }
}
