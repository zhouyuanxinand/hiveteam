import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { DispatchPullRequest, DispatchPullRequestView } from '../shared/pull-request.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { runGit } from './git-command.js'
import type { GitWorkspaceService } from './git-workspace-service.js'
import { createGitHubClient, type GitHubClient } from './github-pull-requests.js'
import { readGitHubRepository } from './github-remote.js'
import { ConflictError, HttpError } from './http-errors.js'
import { createPullRequestStore } from './pull-request-store.js'
import type { VerificationRuntime } from './verification-runtime.js'
import type { WorkerWorktreeRuntime } from './worker-worktree-runtime.js'
import type { WorkspaceStore } from './workspace-store-contract.js'

export const createPullRequestRuntime = (input: {
  db: Database
  worktrees: WorkerWorktreeRuntime
  workspaceStore: WorkspaceStore
  agentRuntime: AgentRuntime
  verifications: VerificationRuntime
  git: GitWorkspaceService
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  github?: GitHubClient
}) => {
  const store = createPullRequestStore(input.db)
  const github = input.github ?? createGitHubClient()
  store.interruptUnfinished()
  const getTree = (workspaceId: string, dispatchId: string) => {
    const dispatch = input.getDispatch(workspaceId, dispatchId)
    if (!dispatch) throw new HttpError(404, 'Dispatch not found')
    return { dispatch, tree: input.worktrees.get(workspaceId, dispatch.toAgentId) }
  }
  const view = async (
    workspaceId: string,
    dispatchId: string
  ): Promise<DispatchPullRequestView> => {
    const { dispatch, tree } = getTree(workspaceId, dispatchId)
    const publication = store.get(workspaceId, dispatchId)
    const result: DispatchPullRequestView = {
      repository: null,
      branch: tree?.branch ?? null,
      baseBranch: tree?.targetBranch ?? null,
      headSha: null,
      verificationId: null,
      canPublish: false,
      reason: null,
      publication,
    }
    if (!tree) {
      result.reason = 'isolation_required'
      return result
    }
    const source = await input.worktrees.validate(tree)
    result.headSha = source.headSha
    result.repository = await readGitHubRepository(tree.checkoutPath)
    const verification = await input.verifications.view(workspaceId, dispatchId)
    result.verificationId = verification.runs[0]?.id ?? null
    if (!result.repository) result.reason = 'github_remote_required'
    else if (source.isDirty || !source.headSha || source.unavailableReason)
      result.reason = 'source_dirty'
    else if (!verification.accepted) result.reason = 'accept_required'
    else if (input.workspaceStore.getWorker(workspaceId, dispatch.toAgentId).pendingTaskCount)
      result.reason = 'pending_tasks'
    else if (input.agentRuntime.getActiveRunByAgentId(workspaceId, dispatch.toAgentId))
      result.reason = 'agents_running'
    else if (
      publication &&
      (publication.repository !== result.repository ||
        publication.branch !== result.branch ||
        publication.baseBranch !== result.baseBranch)
    )
      result.reason = 'destination_changed'
    else if (publication?.state === 'publishing') result.reason = 'publishing'
    else if (publication?.snapshot?.state === 'merged' || publication?.snapshot?.state === 'closed')
      result.reason = 'pull_request_closed'
    else if (
      publication?.state === 'published' &&
      publication.headSha === source.headSha &&
      publication.verificationId === result.verificationId &&
      (!publication.snapshot || publication.snapshot.headSha === source.headSha)
    )
      result.reason = 'published'
    result.canPublish = !result.reason
    return result
  }
  const refresh = async (workspaceId: string, dispatchId: string) => {
    const { tree } = getTree(workspaceId, dispatchId)
    const current = store.get(workspaceId, dispatchId)
    if (!tree || !current?.number)
      throw new ConflictError('Publish a pull request before refreshing its status.')
    try {
      const snapshot = await github.read(tree.repoRoot, current.repository, current.number)
      if (snapshot.headBranch !== current.branch || snapshot.baseBranch !== current.baseBranch)
        throw new ConflictError('The pull request branch or base changed. Review it on GitHub.')
      store.save({ ...current, snapshot, error: null, updatedAt: Date.now() })
    } catch (error) {
      store.save({
        ...current,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      })
      throw error
    }
    return view(workspaceId, dispatchId)
  }
  return {
    view,
    refresh: (workspaceId: string, dispatchId: string) =>
      input.worktrees.exclusive(workspaceId, () => refresh(workspaceId, dispatchId)),
    publish(
      workspaceId: string,
      dispatchId: string,
      request: {
        headSha: string
        verificationId: string
        repository: string
        branch: string
        baseBranch: string
        title: string
        body: string
      }
    ) {
      return input.worktrees.exclusive(workspaceId, () =>
        input.git.withWorkspaceOperation(workspaceId, async () => {
          const current = await view(workspaceId, dispatchId)
          if (
            !current.canPublish ||
            current.headSha !== request.headSha ||
            current.verificationId !== request.verificationId ||
            current.repository !== request.repository ||
            current.branch !== request.branch ||
            current.baseBranch !== request.baseBranch
          )
            throw new ConflictError(
              'Publication changed or is blocked. Refresh and review the accepted commit and destination.'
            )
          const { tree } = getTree(workspaceId, dispatchId)
          if (!tree) throw new ConflictError('An isolated worktree is required.')
          let record: DispatchPullRequest = {
            dispatchId,
            workspaceId,
            headSha: request.headSha,
            verificationId: request.verificationId,
            repository: request.repository,
            branch: request.branch,
            baseBranch: request.baseBranch,
            state: 'publishing',
            number: current.publication?.number ?? null,
            snapshot: current.publication?.snapshot ?? null,
            error: null,
            updatedAt: Date.now(),
          }
          store.save(record)
          try {
            const number =
              record.number ??
              (await github.find(
                tree.repoRoot,
                record.repository,
                record.branch,
                record.baseBranch
              ))
            if (number) {
              const snapshot = await github.read(tree.repoRoot, record.repository, number)
              if (
                snapshot.state !== 'open' ||
                snapshot.headBranch !== record.branch ||
                snapshot.baseBranch !== record.baseBranch
              )
                throw new ConflictError(
                  'The existing pull request is closed or its destination changed. Review it on GitHub.'
                )
              record = { ...record, number, snapshot }
              store.save(record)
            }
            // Push the reviewed commit without rewriting remote history, even if
            // an external editor moves the local branch during the request.
            const hooks = join(tree.checkoutPath, '..', 'empty-hooks')
            await mkdir(hooks, { recursive: true })
            await runGit(
              tree.checkoutPath,
              [
                '-c',
                `core.hooksPath=${hooks}`,
                'push',
                '--no-follow-tags',
                'origin',
                `${request.headSha}:refs/heads/${request.branch}`,
              ],
              {
                timeout: 120_000,
                env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
              }
            )
            if (!record.number) {
              record = {
                ...record,
                number: await github.create(tree.repoRoot, record.repository, request),
              }
              store.save(record)
            }
            record = { ...record, state: 'published', updatedAt: Date.now() }
            store.save(record)
          } catch (error) {
            store.save({
              ...record,
              state: 'failed',
              error: error instanceof Error ? error.message : String(error),
              updatedAt: Date.now(),
            })
            throw error
          }
          // A status failure must not erase the successful publication receipt.
          try {
            return await refresh(workspaceId, dispatchId)
          } catch {
            // Publication already succeeded. The refresh stored its error on
            // the durable receipt; expose that partial result to the user.
            return view(workspaceId, dispatchId)
          }
        })
      )
    },
  }
}
export type PullRequestRuntime = ReturnType<typeof createPullRequestRuntime>
