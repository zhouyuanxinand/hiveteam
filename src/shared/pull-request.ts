export type CheckState = 'pending' | 'passed' | 'failed' | 'skipped' | 'unknown'
export type CiState = CheckState | 'none'

export interface PullRequestCheck {
  id: string
  name: string
  state: CheckState
  url: string | null
}

export interface PullRequestSnapshot {
  number: number
  url: string
  title: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  headSha: string
  headBranch: string
  baseSha: string
  baseBranch: string
  ciState: CiState
  checks: PullRequestCheck[]
  checkedAt: number
}

export interface DispatchPullRequest {
  dispatchId: string
  workspaceId: string
  verificationId: string
  headSha: string
  repository: string
  branch: string
  baseBranch: string
  state: 'publishing' | 'published' | 'failed'
  number: number | null
  snapshot: PullRequestSnapshot | null
  error: string | null
  updatedAt: number
}

export interface DispatchPullRequestView {
  repository: string | null
  branch: string | null
  baseBranch: string | null
  headSha: string | null
  verificationId: string | null
  canPublish: boolean
  reason: string | null
  publication: DispatchPullRequest | null
}
