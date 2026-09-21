export type VerificationState =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface DispatchVerification {
  profile?: import('./verification-profile.js').VerificationProfile
  logBytes?: number
  subject?: { candidate_id: string; target_sha: string; source_sha: string; repository_id: string }
  id: string
  workspaceId: string
  dispatchId: string
  reportRevision: number
  headSha: string
  command: string
  state: VerificationState
  output: string
  outputTruncated: boolean
  exitCode: number | null
  error: string | null
  startedAt: number
  endedAt: number | null
  acceptedAt: number | null
}

export type VerificationStaleReason = 'report_changed' | 'code_changed' | 'uncommitted_changes'

export interface DispatchVerificationView {
  isolated?: boolean
  headSha: string | null
  isDirty: boolean
  unavailableReason: string | null
  reportRevision: number
  canRun: boolean
  canAccept: boolean
  staleReason: VerificationStaleReason | null
  accepted: boolean
  runs: DispatchVerification[]
}
