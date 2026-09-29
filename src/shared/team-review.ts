import type { CodeReviewStaleReason } from './code-review.js'

/** A review request owns preparation; its task state comes from the dispatch ledger. */
export interface TeamReviewRecord {
  id: string
  workspace_id: string
  source_dispatch_id: string
  source_report_revision: number
  source_head_sha: string
  source_base_sha: string
  repository_id: string
  baseline_kind: 'target_head' | 'dispatch_base'
  focus: string
  command_preset_id: string
  requested_by: string
  reviewer_id: string
  review_dispatch_id: string | null
  created_at: number
  last_error: string | null
}

export interface TeamReviewView extends TeamReviewRecord {
  state: 'preparing' | 'queued' | 'submitted' | 'failed' | 'reported' | 'cancelled'
  stale_reason: Exclude<CodeReviewStaleReason, 'superseded'> | null
  reviewer_retired_at: number | null
  working_directory: string | null
  worktree_dirty: boolean | null
  worktree_error: string | null
  report_text: string | null
  report_outcome: string | null
  report_revision: number
  artifacts: string[]
}
