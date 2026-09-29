import type { MemoryDreamGeneration } from '../shared/memory-dream-generation.js'
import type { Database } from './sqlite.js'

export interface MemoryDreamGenerationRow {
  dream_id: string
  workspace_id: string
  status: MemoryDreamGeneration['status']
  input_json: string
  input_hash: string
  attempt_id: string | null
  run_id: string | null
  requested_at: number | null
  completed_at: number | null
  error: string | null
  result_json: string | null
  result_hash: string | null
  candidate_count: number | null
  result_summary: string | null
}
export const readDreamGenerationRow = (db: Database, workspaceId: string, dreamId: string) =>
  db
    .prepare('SELECT * FROM memory_dream_generations WHERE workspace_id=? AND dream_id=?')
    .get(workspaceId, dreamId) as MemoryDreamGenerationRow | undefined
export const readDreamGeneration = (
  db: Database,
  workspaceId: string,
  dreamId: string
): MemoryDreamGeneration | null => {
  const row = readDreamGenerationRow(db, workspaceId, dreamId)
  return row
    ? {
        status: row.status,
        attempt_id: row.attempt_id,
        run_id: row.run_id,
        requested_at: row.requested_at,
        completed_at: row.completed_at,
        error: row.error,
        input_hash: row.input_hash,
        candidate_count: row.candidate_count,
        result_summary: row.result_summary,
        input: JSON.parse(row.input_json),
      }
    : null
}
