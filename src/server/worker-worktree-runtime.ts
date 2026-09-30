import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { WorkspaceSummary } from '../shared/types.js'
import type { WorkerWorktree } from '../shared/worker-worktree.js'
import { readCodeReviewRepositoryId } from './code-review-git.js'
import { runGit } from './git-command.js'
import { ConflictError } from './http-errors.js'
import type { Database } from './sqlite.js'
import { readVerificationVersion } from './verification-worktree.js'
import { createWorkerWorktreeStore } from './worker-worktree-store.js'

export interface PinnedWorkerCommit {
  headSha: string
  repositoryId: string
}

/** Durable working directories shared by PTY launch, diff, and verification. */
export const createWorkerWorktreeRuntime = (db: Database, dataDir: string | null) => {
  const store = createWorkerWorktreeStore(db)
  store.interruptPreparing()
  const active = new Map<string, Promise<unknown>>()
  const starts = new Map<string, Set<Promise<unknown>>>()
  let closing = false
  const assertIdle = (workspaceId: string) => {
    if (closing || active.has(workspaceId))
      throw new ConflictError('A worktree operation is in progress. Wait and retry.')
  }
  const exclusive = <T>(workspaceId: string, operation: () => Promise<T>): Promise<T> => {
    assertIdle(workspaceId)
    if (starts.get(workspaceId)?.size)
      throw new ConflictError('A worker is starting. Wait and retry.')
    const pending = Promise.resolve().then(operation)
    active.set(workspaceId, pending)
    return pending.finally(() => {
      if (active.get(workspaceId) === pending) active.delete(workspaceId)
    })
  }
  const assertCanChangeWorkers = (workspaceId: string) => {
    assertIdle(workspaceId)
    if (starts.get(workspaceId)?.size)
      throw new ConflictError('A worker is starting. Wait and retry.')
  }
  const path = (workspace: WorkspaceSummary, agentId: string) => {
    const tree = store.get(workspace.id, agentId)
    if (!tree) return workspace.path
    if (tree.state !== 'ready')
      throw new ConflictError(
        tree.error ?? 'The isolated worktree is not ready. Inspect its path before retrying.'
      )
    return tree.workspacePath
  }
  const validate = async (tree: WorkerWorktree, allowMerge = false) => {
    if (tree.state !== 'ready')
      throw new ConflictError(tree.error ?? 'Worktree preparation has not completed.')
    const version = await readVerificationVersion(tree.workspacePath)
    if (
      version.repoRoot !== tree.checkoutPath ||
      !('branch' in version) ||
      version.branch !== tree.branch
    )
      throw new ConflictError(
        'The isolated worktree is missing or its branch changed. Restore its recorded path and branch.'
      )
    const commonDir = async (cwd: string) =>
      realpath(
        (await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
      )
    if ((await commonDir(tree.checkoutPath)) !== (await commonDir(tree.repoRoot)))
      throw new ConflictError('The isolated worktree no longer belongs to this repository.')
    if (!allowMerge && version.unavailableReason)
      throw new ConflictError(
        'Finish or abort the Git operation in this isolated directory before continuing.'
      )
    if (tree.pinnedHeadSha && (version.headSha !== tree.pinnedHeadSha || version.isDirty))
      throw new ConflictError(
        'The review checkout changed. Restore its recorded commit and inspect any local edits before restarting.'
      )
    return version
  }
  return {
    isBusy: (workspaceId: string) =>
      closing || active.has(workspaceId) || !!starts.get(workspaceId)?.size,
    get: store.get,
    path,
    validate,
    exclusive,
    assertIdle,
    assertCanChangeWorkers,
    create(workspace: WorkspaceSummary, workerId: string, pin?: PinnedWorkerCommit) {
      return exclusive(workspace.id, async () => {
        if (!dataDir)
          throw new ConflictError('Isolated workers require a persistent HiveTeam data directory.')
        const version = await readVerificationVersion(workspace.path)
        if (
          !version.repoRoot ||
          !version.headSha ||
          (!pin && version.isDirty) ||
          !('branch' in version) ||
          !version.branch
        )
          throw new ConflictError(
            'Commit workspace changes and check out a branch before creating an isolated worker.'
          )
        if (pin) {
          if (
            !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(pin.headSha) ||
            (await readCodeReviewRepositoryId(version.repoRoot)) !== pin.repositoryId
          )
            throw new ConflictError(
              'The review commit must belong to the originally recorded repository'
            )
          const commit = (
            await runGit(version.repoRoot, ['rev-parse', '--verify', `${pin.headSha}^{commit}`], {
              env: { GIT_NO_REPLACE_OBJECTS: '1' },
            })
          ).trim()
          if (commit !== pin.headSha)
            throw new ConflictError('The pinned review commit is unavailable')
        }
        const root = resolve(dataDir, 'worker-worktrees')
        await mkdir(root, { recursive: true })
        const rootReal = await realpath(root)
        if (rootReal === version.repoRoot || rootReal.startsWith(`${version.repoRoot}${sep}`))
          throw new ConflictError(
            'HiveTeam data must be outside the project repository to create isolated workers.'
          )
        const id = randomUUID()
        const checkoutPath = join(rootReal, id)
        const workspacePath = resolve(checkoutPath, version.relativePath ?? '.')
        if (workspacePath !== checkoutPath && !workspacePath.startsWith(`${checkoutPath}${sep}`))
          throw new ConflictError('Workspace scope is outside the repository.')
        const tree: WorkerWorktree = {
          workerId,
          workspaceId: workspace.id,
          repoRoot: version.repoRoot,
          checkoutPath,
          workspacePath,
          branch: `hive/worker-${id}`,
          targetBranch: version.branch,
          baseSha: pin?.headSha ?? version.headSha,
          ...(pin ? { pinnedHeadSha: pin.headSha } : {}),
          state: 'preparing',
          error: null,
        }
        store.insert(tree)
        const hooks = join(rootReal, 'empty-hooks')
        try {
          await mkdir(hooks, { recursive: true })
          await runGit(
            version.repoRoot,
            [
              '-c',
              `core.hooksPath=${hooks}`,
              'worktree',
              'add',
              '-b',
              tree.branch,
              checkoutPath,
              tree.baseSha,
            ],
            { timeout: 60_000, env: { GIT_NO_REPLACE_OBJECTS: '1' } }
          )
          if (pin && (await runGit(checkoutPath, ['rev-parse', 'HEAD'])).trim() !== pin.headSha)
            throw new ConflictError('Review checkout HEAD does not match its recorded commit')
          store.finish(workspace.id, workerId, null)
        } catch (error) {
          store.finish(
            workspace.id,
            workerId,
            error instanceof Error ? error.message : String(error)
          )
          throw error
        }
        return { ...tree, state: 'ready' as const }
      })
    },
    async withLaunchWorkspace<T>(
      workspace: WorkspaceSummary,
      agentId: string,
      launch: (workspace: WorkspaceSummary) => Promise<T>
    ): Promise<T> {
      // Starts can run in parallel, but integration cannot overlap a PTY start.
      assertIdle(workspace.id)
      const tree = store.get(workspace.id, agentId)
      // Preserve shared launches' synchronous session-capture snapshot. Adding
      // a microtask here could mistake a newly created native session for an
      // existing one and prevent capture/resume on the next start.
      const pending = tree
        ? validate(tree).then(() => launch({ ...workspace, path: path(workspace, agentId) }))
        : launch(workspace)
      const workspaceStarts = starts.get(workspace.id) ?? new Set<Promise<unknown>>()
      workspaceStarts.add(pending)
      starts.set(workspace.id, workspaceStarts)
      try {
        return await pending
      } finally {
        workspaceStarts.delete(pending)
        if (!workspaceStarts.size) starts.delete(workspace.id)
      }
    },
    async close() {
      closing = true
      await Promise.allSettled(active.values())
      await Promise.allSettled([...starts.values()].flatMap((pending) => [...pending]))
    },
  }
}
export type WorkerWorktreeRuntime = ReturnType<typeof createWorkerWorktreeRuntime>
