import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { AgentRuntime } from './agent-runtime-contract.js'
import { GitCommandError, runGit } from './git-command.js'
import { readMergeState } from './git-merge-state.js'
import { ConflictError, HttpError } from './http-errors.js'
import type { WorkerWorktreeRuntime } from './worker-worktree-runtime.js'
import { createWorktreeResourceStore } from './worktree-resource-store.js'

export const createWorktreeResourceRuntime = (input: {
  db: Database
  dataDir: string | null
  worktrees: WorkerWorktreeRuntime
  agentRuntime: AgentRuntime
}) => {
  const store = createWorktreeResourceStore(input.db)
  const view = async (id: string) => {
    const resource = store.get(id)
    if (!resource) throw new HttpError(404, 'Retained working directory not found')
    let headSha: string | null = null
    let targetSha: string | null = null
    let reason: string | null = null
    if (store.isBound(id)) reason = 'worker_attached'
    else if (input.agentRuntime.getActiveRunByAgentId(resource.workspaceId, id))
      reason = 'agents_running'
    else if (resource.state === 'removed') reason = 'removed'
    else {
      try {
        if (!input.dataDir) throw new ConflictError('Persistent data directory is required.')
        const root = await realpath(resolve(input.dataDir, 'worker-worktrees'))
        if (
          resource.state === 'removing' &&
          !existsSync(resource.checkoutPath) &&
          dirname(resource.checkoutPath) === root &&
          /^[0-9a-f-]{36}$/u.test(basename(resource.checkoutPath))
        ) {
          const registered = (
            await runGit(resource.repoRoot, ['worktree', 'list', '--porcelain', '-z'])
          )
            .split('\0')
            .some(
              (entry) =>
                entry.startsWith('worktree ') && resolve(entry.slice(9)) === resource.checkoutPath
            )
          if (!registered) {
            store.save(id, 'removed')
            return {
              resource: { ...resource, state: 'removed' as const, error: null },
              head_sha: null,
              target_sha: null,
              reason: 'removed',
              can_remove: false,
            }
          }
        }
        const checkout = await realpath(resource.checkoutPath)
        if (
          checkout !== resource.checkoutPath ||
          dirname(checkout) !== root ||
          !/^[0-9a-f-]{36}$/u.test(basename(checkout))
        )
          throw new ConflictError(
            'The recorded directory is outside Hive’s owned worktree directory.'
          )
        const repository = (await runGit(checkout, ['rev-parse', '--show-toplevel'])).trim()
        const common = async (cwd: string) =>
          realpath(
            (await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
          )
        if (
          (await realpath(repository)) !== checkout ||
          (await common(checkout)) !== (await common(resource.repoRoot))
        )
          throw new ConflictError('The recorded directory no longer belongs to this repository.')
        if ((await runGit(checkout, ['branch', '--show-current'])).trim() !== resource.branch)
          throw new ConflictError('The worktree branch changed.')
        headSha = (await runGit(checkout, ['rev-parse', 'HEAD'])).trim()
        targetSha = (
          await runGit(resource.repoRoot, [
            'rev-parse',
            '--verify',
            `refs/heads/${resource.targetBranch}`,
          ])
        ).trim()
        if (await readMergeState(checkout)) reason = 'merge_in_progress'
        else if (
          (await runGit(checkout, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()
        )
          reason = 'uncommitted_changes'
        else {
          try {
            await runGit(resource.repoRoot, ['merge-base', '--is-ancestor', headSha, targetSha])
          } catch (error) {
            if (error instanceof GitCommandError && error.exitCode === 1) reason = 'not_integrated'
            else throw error
          }
        }
      } catch (error) {
        // Keep failed inspections visible per directory; no deletion occurs.
        reason = error instanceof Error ? error.message : String(error)
      }
    }
    return { resource, head_sha: headSha, target_sha: targetSha, reason, can_remove: !reason }
  }
  return {
    view,
    async list(limit: number, offset: number) {
      const result = store.list(limit, offset)
      const items = await Promise.all(result.items.map((resource) => view(resource.workerId)))
      const recovered = items.some((item) => item.reason === 'removed')
      const current = recovered ? store.list(limit, offset) : result
      return {
        total: current.total,
        limit,
        offset,
        items: recovered
          ? await Promise.all(current.items.map((resource) => view(resource.workerId)))
          : items,
      }
    },
    remove(id: string, request: { headSha: string; targetSha: string }) {
      const resource = store.get(id)
      if (!resource) throw new HttpError(404, 'Retained working directory not found')
      return input.worktrees.exclusive(resource.workspaceId, async () => {
        const current = await view(id)
        if (
          !current.can_remove ||
          current.head_sha !== request.headSha ||
          current.target_sha !== request.targetSha
        )
          throw new ConflictError(
            'Directory contents or target branch changed. Refresh before removing it.'
          )
        store.save(id, 'removing')
        try {
          // Git refuses dirty or locked worktrees. Keep the branch and all its
          // commits, and never force removal of user files.
          await runGit(resource.repoRoot, ['worktree', 'remove', resource.checkoutPath], {
            timeout: 60_000,
          })
          store.save(id, 'removed')
        } catch (error) {
          store.save(id, 'retained', error instanceof Error ? error.message : String(error))
          throw error
        }
        return { removed: true, branch: resource.branch }
      })
    },
  }
}
export type WorktreeResourceRuntime = ReturnType<typeof createWorktreeResourceRuntime>
