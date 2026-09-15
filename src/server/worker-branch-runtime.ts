import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { AgentRuntime } from './agent-runtime-contract.js'
import { GitCommandError, runGit } from './git-command.js'
import { readConflictFiles, readMergeState } from './git-merge-state.js'
import type { GitWorkspaceService } from './git-workspace-service.js'
import { ConflictError, HttpError } from './http-errors.js'
import type { VerificationRuntime } from './verification-runtime.js'
import { readVerificationVersion } from './verification-worktree.js'
import { createWorkerBranchStore, type WorkerBranchUpdate } from './worker-branch-store.js'
import type { WorkerWorktreeRuntime } from './worker-worktree-runtime.js'
import type { WorkspaceStore } from './workspace-store-contract.js'

export const createWorkerBranchRuntime = (input: {
  db: Database
  worktrees: WorkerWorktreeRuntime
  workspaceStore: WorkspaceStore
  agentRuntime: AgentRuntime
  git: GitWorkspaceService
  verifications: VerificationRuntime
}) => {
  const store = createWorkerBranchStore(input.db)
  const treeFor = (workspaceId: string, workerId: string) => {
    const tree = input.worktrees.get(workspaceId, workerId)
    if (!tree) throw new HttpError(404, 'Isolated worker not found')
    return tree
  }
  const view = async (workspaceId: string, workerId: string) => {
    const tree = treeFor(workspaceId, workerId)
    const source = await input.worktrees.validate(tree, true)
    const workspace = input.workspaceStore.getWorkspaceSnapshot(workspaceId)
    const target = await readVerificationVersion(workspace.summary.path)
    const merge = await readMergeState(tree.checkoutPath)
    let update = store.get(workspaceId, workerId) ?? null
    if (
      !merge &&
      source.headSha &&
      !source.isDirty &&
      update &&
      (update.state === 'running' || update.state === 'conflicted')
    ) {
      if (source.headSha === update.sourceSha) {
        const next = { ...update, state: 'aborted' as const, error: null }
        store.save(next)
        update = next
      } else {
        try {
          await runGit(tree.checkoutPath, [
            'merge-base',
            '--is-ancestor',
            update.sourceSha,
            source.headSha,
          ])
          await runGit(tree.checkoutPath, [
            'merge-base',
            '--is-ancestor',
            update.targetSha,
            source.headSha,
          ])
          const next = { ...update, state: 'complete' as const, error: null }
          store.save(next)
          update = next
        } catch (error) {
          if (!(error instanceof GitCommandError) || error.exitCode !== 1) throw error
        }
      }
    }
    const conflicts = merge ? await readConflictFiles(tree.checkoutPath) : []
    let reason: string | null = null
    if (input.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) reason = 'agents_running'
    else if (input.workspaceStore.getWorker(workspaceId, workerId).pendingTaskCount)
      reason = 'pending_tasks'
    else if (merge) reason = 'merge_in_progress'
    else if (source.isDirty || !source.headSha || source.unavailableReason) reason = 'source_dirty'
    else if (
      target.repoRoot !== tree.repoRoot ||
      !target.headSha ||
      !('branch' in target) ||
      target.branch !== tree.targetBranch
    )
      reason = 'target_changed'
    else {
      try {
        await runGit(tree.checkoutPath, [
          'merge-base',
          '--is-ancestor',
          target.headSha,
          source.headSha,
        ])
        reason = 'up_to_date'
      } catch (error) {
        if (!(error instanceof GitCommandError) || error.exitCode !== 1) throw error
      }
    }
    const ownedMerge =
      merge === 'MERGE_HEAD' &&
      update &&
      (await runGit(tree.checkoutPath, ['rev-parse', 'MERGE_HEAD'])).trim() === update.targetSha &&
      source.headSha === update.sourceSha
    const patch = merge
      ? await runGit(
          tree.checkoutPath,
          ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--'],
          { maxBuffer: 16 * 1024 * 1024 }
        )
      : ''
    return {
      branch: tree.branch,
      target_branch: tree.targetBranch,
      workspace_path: tree.workspacePath,
      source_sha: source.headSha,
      target_sha: target.headSha,
      reason,
      update,
      conflicts,
      can_update: reason === null,
      can_continue: !!ownedMerge && conflicts.length === 0 && reason === 'merge_in_progress',
      can_abort: !!ownedMerge && reason === 'merge_in_progress',
      patch: patch.slice(0, 256 * 1024),
      truncated: patch.length > 256 * 1024,
    }
  }
  return {
    view,
    act(
      workspaceId: string,
      workerId: string,
      request: { action: 'update' | 'continue' | 'abort'; sourceSha: string; targetSha: string }
    ) {
      return input.worktrees.exclusive(workspaceId, () =>
        input.git.withWorkspaceOperation(workspaceId, async () => {
          const tree = treeFor(workspaceId, workerId)
          const current = await view(workspaceId, workerId)
          input.verifications.assertWorkerIdle(workspaceId, workerId)
          if (
            current.source_sha !== request.sourceSha ||
            (request.action === 'update' ? current.target_sha : current.update?.targetSha) !==
              request.targetSha
          )
            throw new ConflictError('Branch preview changed. Refresh before continuing.')
          if (
            (request.action === 'update' && !current.can_update) ||
            (request.action === 'continue' && !current.can_continue) ||
            (request.action === 'abort' && !current.can_abort)
          )
            throw new ConflictError(
              'Branch operation is blocked. Stop the worker and resolve the displayed condition.'
            )
          const hooks = join(tree.checkoutPath, '..', 'empty-hooks')
          await mkdir(hooks, { recursive: true })
          const config = ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false']
          const record: WorkerBranchUpdate = {
            workerId,
            workspaceId,
            sourceSha: request.sourceSha,
            targetSha: request.targetSha,
            state: 'running',
            error: null,
          }
          store.save(record)
          try {
            const args =
              request.action === 'update'
                ? ['merge', '--no-edit', '--no-autostash', request.targetSha]
                : request.action === 'continue'
                  ? ['commit', '--no-edit']
                  : ['merge', '--abort']
            await runGit(tree.checkoutPath, [...config, ...args], { timeout: 60_000 })
            store.save({ ...record, state: request.action === 'abort' ? 'aborted' : 'complete' })
          } catch (error) {
            const merge = await readMergeState(tree.checkoutPath)
            const conflicts = await readConflictFiles(tree.checkoutPath)
            if (
              error instanceof GitCommandError &&
              error.exitCode === 1 &&
              merge === 'MERGE_HEAD' &&
              conflicts.length
            ) {
              store.save({ ...record, state: 'conflicted' })
            } else {
              store.save({
                ...record,
                state: 'failed',
                error: error instanceof Error ? error.message : String(error),
              })
              throw error
            }
          }
          return view(workspaceId, workerId)
        })
      )
    },
  }
}
export type WorkerBranchRuntime = ReturnType<typeof createWorkerBranchRuntime>
