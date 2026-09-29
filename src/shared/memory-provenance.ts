/** A reference to canonical protocol data; author and content are resolved by the server. */
export type MemorySourceReference =
  | { type: 'dispatch'; source_id: string }
  | { type: 'dispatch_message'; source_id: string; source_sequence: number }

export interface MemorySourceSnapshot {
  id: string
  source_id: string | null
  type: string
  version: string | null
  captured_version: string | null
  state: 'unknown' | 'current' | 'stale' | 'restricted'
  // Optional for context snapshots written before provenance capture was introduced.
  source_workspace_id?: string | null
  source_sequence?: number | null
  excerpt?: string | null
  actor_agent_id_snapshot?: string | null
  actor_name_snapshot?: string | null
  actor_role_snapshot?: string | null
  created_at?: number
  stale?: boolean
}
