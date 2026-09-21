import type { SessionHarness } from './session-adapter.js'

export type NativeSessionErrorCode =
  | 'session_adapter_unverified'
  | 'session_allocation_uncertain'
  | 'session_missing'
  | 'session_access_denied'
  | 'session_occupied'
  | 'session_identity_mismatch'
  | 'session_environment_mismatch'
  | 'session_changed'
  | 'session_native_failure'
  | 'session_delivery_unverified'

export interface NativeSessionContext {
  cwd: string
  platform: string
  storage_root: string
  policy_revision: string
  cli_fingerprint: string
  adapter_revision: string
}

export interface NativeSessionGeneration {
  id: string
  workspace_id: string
  agent_id: string
  generation: number
  harness: SessionHarness
  native_id: string | null
  context: NativeSessionContext
  state: 'pending' | 'bound' | 'uncertain'
  current: boolean
  reason: string
  created_at: number
  updated_at: number
  last_error: { code: NativeSessionErrorCode; message: string } | null
}

export interface NativeSessionAttempt {
  id: string
  generation_id: string
  operation: 'allocate' | 'resume'
  state: 'prepared' | 'allocating' | 'starting' | 'active' | 'closed' | 'failed' | 'uncertain'
  reservation_id: string
  run_id: string | null
  created_at: number
  updated_at: number
  error_code: NativeSessionErrorCode | null
  error_message: string | null
}

export interface NativeSessionView {
  proposed_context: NativeSessionContext | null
  proposed_policy: {
    profile: string
    role: string
    network: string | null
    write_roots: string[]
  } | null
  harness: SessionHarness | null
  current: NativeSessionGeneration | null
  history: NativeSessionGeneration[]
  attempts: NativeSessionAttempt[]
  recoverable: boolean
  reason_code: NativeSessionErrorCode | null
  reason: string
  external_ownership: 'unknown'
  delivery_receipt: 'unverified'
  automatic_input: false
}
