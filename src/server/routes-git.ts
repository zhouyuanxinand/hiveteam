import { BadRequestError, ConflictError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const requireWorkspace = (
  response: Parameters<RouteDefinition['handler']>[0]['response'],
  params: Record<string, string>,
  store: RuntimeStore
) => {
  const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Workspace id is required')
  if (!workspaceId) return null
  const workspace = store.getWorkspaceSnapshot(workspaceId)
  return { id: workspaceId, path: workspace.summary.path }
}

const serializeStatus = (status: Awaited<ReturnType<RuntimeStore['git']['getStatus']>>) => ({
  auto_snapshot_enabled: status.autoSnapshotEnabled,
  branch: status.branch,
  changed_file_count: status.changedFileCount,
  checked_at: status.checkedAt,
  error: status.error,
  head_sha: status.headSha,
  is_dirty: status.isDirty,
  relative_path: status.relativePath,
  repo_root: status.repoRoot,
  staged_file_count: status.stagedFileCount,
  state: status.state,
  untracked_file_count: status.untrackedFileCount,
  workspace_id: status.workspaceId,
  workspace_path: status.workspacePath,
})

const serializeCommit = (
  commit: Awaited<ReturnType<RuntimeStore['git']['listCommits']>>['commits'][number]
) => ({
  author_email: commit.authorEmail,
  author_name: commit.authorName,
  authored_at: commit.authoredAt,
  changed_files: commit.changedFiles,
  committed_at: commit.committedAt,
  deletions: commit.deletions,
  insertions: commit.insertions,
  is_hiveteam_snapshot: commit.isHiveTeamSnapshot,
  message: commit.message,
  parents: commit.parents,
  reverted_by_sha: commit.revertedBySha,
  sha: commit.sha,
  short_sha: commit.shortSha,
  turn_id: commit.turnId,
})

const serializeCommitPage = (page: Awaited<ReturnType<RuntimeStore['git']['listCommits']>>) => ({
  commits: page.commits.map(serializeCommit),
  has_more: page.hasMore,
  limit: page.limit,
  offset: page.offset,
})

const serializeSnapshotResult = (
  result: Awaited<ReturnType<RuntimeStore['git']['createSnapshot']>>
) => ({
  changed_files: result.changedFiles,
  commit: result.commit ? serializeCommit(result.commit) : null,
  deletions: result.deletions,
  insertions: result.insertions,
  outcome: result.outcome,
})

const serializeRevertResult = (
  result: Awaited<ReturnType<RuntimeStore['git']['revertSnapshot']>>
) => ({
  commit: serializeCommit(result.commit),
  reverted_sha: result.revertedSha,
})

const toGitHttpError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /HEAD changed|current workspace changes|not an ancestor|not a HiveTeam snapshot/iu.test(message)
  ) {
    return new ConflictError(message)
  }
  return new BadRequestError(message)
}

const parsePageOptions = (requestUrl: string | undefined) => {
  const url = new URL(requestUrl ?? '/', 'http://127.0.0.1')
  const rawLimit = Number(url.searchParams.get('limit') ?? '30')
  const rawOffset = Number(url.searchParams.get('offset') ?? '0')
  return {
    limit: Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 30,
    offset: Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0,
  }
}

export const gitRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/git/status',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspace = requireWorkspace(response, params, store)
      if (!workspace) return
      const status = await store.git.getStatus(workspace.id, workspace.path)
      sendJson(response, 200, serializeStatus(status))
    }
  ),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/git/commits',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspace = requireWorkspace(response, params, store)
      if (!workspace) return
      const options = parsePageOptions(request.url)
      const page = await store.git.listCommits(workspace.id, workspace.path, options)
      sendJson(response, 200, serializeCommitPage(page))
    }
  ),
  route(
    'PUT',
    '/api/ui/workspaces/:workspaceId/git/settings',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspace = requireWorkspace(response, params, store)
      if (!workspace) return
      const body = await readJsonBody<{ auto_snapshot_enabled?: unknown }>(request)
      if (typeof body.auto_snapshot_enabled !== 'boolean') {
        throw new BadRequestError('auto_snapshot_enabled must be a boolean')
      }
      store.git.setAutoSnapshot(workspace.id, body.auto_snapshot_enabled)
      const status = await store.git.getStatus(workspace.id, workspace.path)
      sendJson(response, 200, serializeStatus(status))
    }
  ),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/git/initialize',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspace = requireWorkspace(response, params, store)
      if (!workspace) return
      const status = await store.git.initialize(workspace.id, workspace.path)
      sendJson(response, 201, serializeStatus(status))
    }
  ),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/git/snapshots',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspace = requireWorkspace(response, params, store)
      if (!workspace) return
      const body = await readJsonBody<{
        expected_head?: unknown
        message?: unknown
        turn_id?: unknown
      }>(request)
      if (
        body.expected_head !== undefined &&
        body.expected_head !== null &&
        typeof body.expected_head !== 'string'
      ) {
        throw new BadRequestError('expected_head must be a string or null')
      }
      if (body.message !== undefined && typeof body.message !== 'string') {
        throw new BadRequestError('message must be a string')
      }
      if (body.turn_id !== undefined && body.turn_id !== null && typeof body.turn_id !== 'string') {
        throw new BadRequestError('turn_id must be a string or null')
      }
      try {
        const result = await store.git.createSnapshot({
          expectedHead: typeof body.expected_head === 'string' ? body.expected_head : null,
          turnId: typeof body.turn_id === 'string' ? body.turn_id : null,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          ...(typeof body.message === 'string' ? { message: body.message } : {}),
        })
        sendJson(
          response,
          result.outcome === 'created' ? 201 : 200,
          serializeSnapshotResult(result)
        )
      } catch (error) {
        throw toGitHttpError(error)
      }
    }
  ),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/git/commits/:commitSha/revert',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspace = requireWorkspace(response, params, store)
      const commitSha = getRequiredParam(response, params, 'commitSha', 'Commit SHA is required')
      if (!workspace || !commitSha) return
      const body = await readJsonBody<{ expected_head?: unknown }>(request)
      if (
        body.expected_head !== undefined &&
        body.expected_head !== null &&
        typeof body.expected_head !== 'string'
      ) {
        throw new BadRequestError('expected_head must be a string or null')
      }
      try {
        const result = await store.git.revertSnapshot({
          commitSha,
          expectedHead: typeof body.expected_head === 'string' ? body.expected_head : null,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
        })
        sendJson(response, 200, serializeRevertResult(result))
      } catch (error) {
        throw toGitHttpError(error)
      }
    }
  ),
]
