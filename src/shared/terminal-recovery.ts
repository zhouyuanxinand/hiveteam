export interface TerminalSessionRecovery {
  kind: 'codex_session_in_use'
  thread_id: string | null
}

export type TerminalSessionRetryStatus =
  | 'still_locked'
  | 'prompt_cleared'
  | 'not_locked'
  | 'retry_pending'
  | 'unavailable'
