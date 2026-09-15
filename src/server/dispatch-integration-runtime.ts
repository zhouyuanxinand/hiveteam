import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { DispatchIntegrationView } from '../shared/worker-worktree.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { GitCommandError, runGit } from './git-command.js'
import type { GitWorkspaceService } from './git-workspace-service.js'
import { ConflictError, HttpError } from './http-errors.js'
import type { VerificationRuntime } from './verification-runtime.js'
import { readVerificationVersion } from './verification-worktree.js'
import type { WorkerWorktreeRuntime } from './worker-worktree-runtime.js'
import { createWorkerWorktreeStore } from './worker-worktree-store.js'
import type { WorkspaceStore } from './workspace-store-contract.js'

const PATCH_LIMIT = 256 * 1024
const isAncestor = async (cwd: string, ancestor: string, descendant: string) => {
  try {
    await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return false
    throw error
  }
}

export const createDispatchIntegrationRuntime = (input: {
  db: Database
  worktrees: WorkerWorktreeRuntime
  workspaceStore: WorkspaceStore
  agentRuntime: AgentRuntime
  verifications: VerificationRuntime
  git: GitWorkspaceService
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
}) => {
  const store = createWorkerWorktreeStore(input.db)
  const view = async (
    workspaceId: string,
    dispatchId: string
  ): Promise<DispatchIntegrationView> => {
    const dispatch = input.getDispatch(workspaceId, dispatchId)
    if (!dispatch) throw new HttpError(404, 'Dispatch not found')
    const tree = input.worktrees.get(workspaceId, dispatch.toAgentId) ?? null
    const result: DispatchIntegrationView = {
      worktree: tree,
      sourceSha: null,
      targetSha: null,
      verificationId: null,
      canIntegrate: false,
      reason: null,
      integratedAt: null,
      patch: '',
      truncated: false,
    }
    if (!tree) return result
    const source = await input.worktrees.validate(tree)
    result.sourceSha = source.headSha
    const workspace = input.workspaceStore.getWorkspaceSnapshot(workspaceId)
    const target = await readVerificationVersion(workspace.summary.path)
    result.targetSha = target.headSha
    const verification = await input.verifications.view(workspaceId, dispatchId)
    const latest = verification.runs[0]
    result.verificationId = latest?.id ?? null
    if (
      latest?.headSha === source.headSha &&
      source.headSha &&
      target.headSha &&
      target.repoRoot === tree.repoRoot &&
      (await isAncestor(tree.repoRoot, source.headSha, target.headSha))
    )
      result.integratedAt = store.integration(latest.id)?.integratedAt ?? null
    if (!source.headSha || source.isDirty || source.unavailableReason)
      result.reason = 'source_dirty'
    else if (
      target.repoRoot !== tree.repoRoot ||
      !target.headSha ||
      !('branch' in target) ||
      target.branch !== tree.targetBranch
    )
      result.reason = 'target_changed'
    else if (target.isDirty) result.reason = 'target_dirty'
    else if (!verification.accepted) result.reason = 'accept_required'
    else if (input.workspaceStore.getWorker(workspaceId, dispatch.toAgentId).pendingTaskCount > 0)
      result.reason = 'pending_tasks'
    else if (
      workspace.agents.some(
        (agent) =>
          (agent.id === dispatch.toAgentId || !input.worktrees.get(workspaceId, agent.id)) &&
          input.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
      )
    )
      result.reason = 'agents_running'
    else if (!(await isAncestor(tree.repoRoot, target.headSha, source.headSha)))
      result.reason = 'target_diverged'
    if (target.repoRoot === tree.repoRoot && target.headSha && source.headSha) {
      const patch = await runGit(
        tree.repoRoot,
        ['diff', '--no-ext-diff', '--no-textconv', target.headSha, source.headSha, '--'],
        { maxBuffer: 16 * 1024 * 1024 }
      )
      result.patch = patch.slice(0, PATCH_LIMIT)
      result.truncated = patch.length > PATCH_LIMIT
    }
    result.canIntegrate = result.reason === null && result.integratedAt === null
    return result
  }
  return {
    view,
    integrate(
      workspaceId: string,
      dispatchId: string,
      request: { sourceSha: string; targetSha: string; verificationId: string }
    ) {
      return input.worktrees.exclusive(workspaceId, () =>
        input.git.withWorkspaceOperation(workspaceId, async () => {
          const current = await view(workspaceId, dispatchId)
          if (
            !current.worktree ||
            current.reason ||
            current.sourceSha !== request.sourceSha ||
            current.targetSha !== request.targetSha ||
            current.verificationId !== request.verificationId
          )
            throw new ConflictError(
              'Integration changed or is blocked. Refresh the preview before integrating.'
            )
          const latest = await input.verifications.view(workspaceId, dispatchId)
          if (!latest.accepted || latest.runs[0]?.id !== request.verificationId)
            throw new ConflictError('Verification changed. Review and accept the latest result.')
          // --ff-only installs exactly the accepted commit: no unverified merge
          // result, conflict resolution, branch reset, or hook execution.
          const hooks = join(current.worktree.checkoutPath, '..', 'empty-hooks')
          await mkdir(hooks, { recursive: true })
          await runGit(
            current.worktree.repoRoot,
            ['-c', `core.hooksPath=${hooks}`, 'merge', '--ff-only', '--no-edit', request.sourceSha],
            { timeout: 60_000 }
          )
          store.recordIntegration(request.verificationId, request.targetSha)
          return view(workspaceId, dispatchId)
        })
      )
    },
  }
}
export type DispatchIntegrationRuntime = ReturnType<typeof createDispatchIntegrationRuntime>
