import { serializeDispatchRecord } from './dispatch-ledger-serializer.js'
import { getRequiredParam, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const MAX_ACTIVITY_LIMIT = 100
const DEFAULT_ACTIVITY_LIMIT = 50
const RECENT_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const readLimit = (requestUrl: string | undefined) => {
  const url = new URL(requestUrl ?? '/', 'http://127.0.0.1')
  const raw = url.searchParams.get('limit')
  if (raw === null) return DEFAULT_ACTIVITY_LIMIT
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) return DEFAULT_ACTIVITY_LIMIT
  return Math.min(MAX_ACTIVITY_LIMIT, Math.max(1, Number(raw)))
}

export const activityRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/activity',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspace = store.getWorkspaceSnapshot(workspaceId)
      const limit = readLimit(request.url)
      const dispatches = store.listDispatches(workspaceId, { limit, offset: 0 })
      const workers = store.listWorkers(workspaceId)
      const messages = store.listMessagesForRecovery(
        workspaceId,
        Date.now() - RECENT_ACTIVITY_WINDOW_MS
      )
      const terminalRuns = store.listTerminalRuns(workspaceId)

      let git: Record<string, unknown> | null = null
      let gitCommits: Array<Record<string, unknown>> = []
      try {
        const status = await store.git.getStatus(workspaceId, workspace.summary.path)
        git = {
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
        }
        const commits = await store.git.listCommits(workspaceId, workspace.summary.path, {
          limit,
          offset: 0,
        })
        gitCommits = commits.commits.map((commit) => ({
          authored_at: commit.authoredAt,
          changed_files: commit.changedFiles,
          committed_at: commit.committedAt,
          deletions: commit.deletions,
          insertions: commit.insertions,
          is_hiveteam_snapshot: commit.isHiveTeamSnapshot,
          message: commit.message,
          sha: commit.sha,
          short_sha: commit.shortSha,
          turn_id: commit.turnId,
        }))
      } catch (error) {
        git = {
          error: error instanceof Error ? error.message : String(error),
          state: 'error',
        }
      }

      sendJson(response, 200, {
        dispatches: dispatches.map(serializeDispatchRecord),
        generated_at: Date.now(),
        git,
        git_commits: gitCommits,
        messages: messages.slice(-limit).map((message) => {
          const payload: Record<string, unknown> = {
            created_at: message.createdAt,
            text: message.text,
            type: message.type,
          }
          if (message.type === 'send') {
            payload.from = message.from ?? null
            payload.to = message.to
          } else if (message.type === 'report' || message.type === 'status') {
            payload.artifacts = message.artifacts
            payload.from = message.from
            if (message.type === 'report') payload.status = message.status ?? null
          }
          return payload
        }),
        terminal_runs: terminalRuns,
        workers: workers.map((worker) => ({
          id: worker.id,
          last_pty_line: worker.lastPtyLine ?? null,
          name: worker.name,
          pending_task_count: worker.pendingTaskCount,
          role: worker.role,
          status: worker.status,
        })),
        workspace: {
          id: workspace.summary.id,
          name: workspace.summary.name,
          path: workspace.summary.path,
        },
      })
    }
  ),
]
