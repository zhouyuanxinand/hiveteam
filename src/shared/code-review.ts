/** Versioned review evidence is independent of report acceptance and verification. */
export interface CodeReviewVersion {
  repository_id: string
  source_sha: string
  base_sha: string
  report_revision: number
}

export type CodeReviewConclusion = 'approve' | 'changes_requested' | 'comment'
export type CodeReviewStaleReason =
  | 'repository_changed'
  | 'report_changed'
  | 'code_changed'
  | 'baseline_changed'
  | 'uncommitted_changes'
  | 'unavailable'
  | 'superseded'

export interface CodeReviewRecord extends CodeReviewVersion {
  id: string
  workspace_id: string
  dispatch_id: string
  reviewer_id: string
  reviewer_run_id: string | null
  reviewer_policy_id: string | null
  conclusion: CodeReviewConclusion
  summary: string
  created_at: number
  accepted_at: number | null
  accepted_by: string | null
}

export interface CodeReviewView {
  version: CodeReviewVersion | null
  baseline_kind: 'target_head' | 'dispatch_base'
  unavailable_reason: string | null
  is_dirty: boolean
  accepted: boolean
  reviews: Array<
    CodeReviewRecord & { stale_reason: CodeReviewStaleReason | null; can_accept: boolean }
  >
}

export interface CodeReviewContext extends CodeReviewView {
  patch: string
  patch_truncated: boolean
  omitted_sensitive_files: number
}

export const sameCodeReviewVersion = (left: CodeReviewVersion, right: CodeReviewVersion) =>
  left.repository_id === right.repository_id &&
  left.source_sha === right.source_sha &&
  left.base_sha === right.base_sha &&
  left.report_revision === right.report_revision
