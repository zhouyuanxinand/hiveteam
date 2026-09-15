import type { DispatchPullRequestView, PullRequestSnapshot } from '../shared/pull-request.js'
import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const serializeSnapshot = (value: PullRequestSnapshot) => ({
  number: value.number,
  url: value.url,
  title: value.title,
  state: value.state,
  draft: value.draft,
  head_sha: value.headSha,
  head_branch: value.headBranch,
  base_sha: value.baseSha,
  base_branch: value.baseBranch,
  ci_state: value.ciState,
  checks: value.checks,
  checked_at: value.checkedAt,
})
const serialize = (view: DispatchPullRequestView) => ({
  repository: view.repository,
  branch: view.branch,
  base_branch: view.baseBranch,
  head_sha: view.headSha,
  verification_id: view.verificationId,
  can_publish: view.canPublish,
  reason: view.reason,
  publication: view.publication
    ? {
        head_sha: view.publication.headSha,
        verification_id: view.publication.verificationId,
        repository: view.publication.repository,
        branch: view.publication.branch,
        base_branch: view.publication.baseBranch,
        state: view.publication.state,
        number: view.publication.number,
        snapshot: view.publication.snapshot ? serializeSnapshot(view.publication.snapshot) : null,
        error: view.publication.error,
        updated_at: view.publication.updatedAt,
      }
    : null,
})
const base = '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId/pull-request'
const ids = (params: Record<string, string>) => {
  if (!params.workspaceId || !params.dispatchId)
    throw new BadRequestError('Workspace and dispatch are required')
  return [params.workspaceId, params.dispatchId] as const
}
export const pullRequestRoutes: RouteDefinition[] = [
  route('GET', base, async ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, serialize(await store.pullRequests.view(...ids(params))))
  }),
  route('POST', `${base}/refresh`, async ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, serialize(await store.pullRequests.refresh(...ids(params))))
  }),
  route('POST', base, async ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<Record<string, unknown>>(request)
    if (
      !body ||
      typeof body.head_sha !== 'string' ||
      !/^[0-9a-f]{40,64}$/u.test(body.head_sha) ||
      typeof body.verification_id !== 'string' ||
      !body.verification_id ||
      typeof body.repository !== 'string' ||
      typeof body.branch !== 'string' ||
      typeof body.base_branch !== 'string' ||
      typeof body.title !== 'string' ||
      !body.title.trim() ||
      body.title.length > 256 ||
      typeof body.body !== 'string' ||
      body.body.length > 60_000
    )
      throw new BadRequestError(
        'Reviewed commit, verification, repository, branches, title (1–256), and body (up to 60000 characters) are required'
      )
    sendJson(
      response,
      200,
      serialize(
        await store.pullRequests.publish(...ids(params), {
          headSha: body.head_sha,
          verificationId: body.verification_id,
          repository: body.repository,
          branch: body.branch,
          baseBranch: body.base_branch,
          title: body.title.trim(),
          body: body.body,
        })
      )
    )
  }),
]
