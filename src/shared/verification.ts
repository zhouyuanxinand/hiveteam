export type VerificationState = 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted'

export interface DispatchVerification {
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
