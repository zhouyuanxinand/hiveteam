export type IntegrationCandidateState =
  | 'queued'
  | 'preparing'
  | 'conflicted'
  | 'prepared'
  | 'failed'
  | 'stale'
  | 'integrating'
  | 'integrated'
  | 'abandoned'
export interface IntegrationCandidate {
  id: string
  workspace_id: string
  dispatch_id: string
  repository_id: string
  source_sha: string
  target_sha: string
  target_branch: string
  report_revision: number
  source_verification_id: string
  source_review_id: string
  checkout_path: string
  candidate_sha: string | null
  state: IntegrationCandidateState
  verification_id: string | null
  review_sha: string | null
  review_note: string | null
  reviewed_at: number | null
  accepted_at: number | null
  integrated_at: number | null
  error: string | null
  created_at: number
  updated_at: number
}
export interface IntegrationCandidateView {
  history: Array<{ id: string; recorded_at: number; snapshot: IntegrationCandidate }>
  candidate: IntegrationCandidate
  patch: string
  truncated: boolean
  conflicts: string[]
  verification: import('./verification.js').DispatchVerification | null
  can_accept: boolean
  can_integrate: boolean
  stale_reason: string | null
}
