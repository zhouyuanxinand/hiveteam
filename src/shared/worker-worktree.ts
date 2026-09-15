export interface WorkerWorktree {
  workerId: string
  workspaceId: string
  repoRoot: string
  checkoutPath: string
  workspacePath: string
  branch: string
  targetBranch: string
  baseSha: string
  state: 'preparing' | 'ready' | 'failed'
  error: string | null
}

export interface DispatchIntegrationView {
  worktree: WorkerWorktree | null
  sourceSha: string | null
  targetSha: string | null
  verificationId: string | null
  canIntegrate: boolean
  reason: string | null
  integratedAt: number | null
  patch: string
  truncated: boolean
}
