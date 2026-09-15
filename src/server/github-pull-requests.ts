import type {
  CheckState,
  CiState,
  PullRequestCheck,
  PullRequestSnapshot,
} from '../shared/pull-request.js'
import {
  type GitHubRequest,
  githubArray,
  githubNumber,
  githubObject,
  githubString,
  requestGitHub,
} from './github-api.js'
import { HttpError } from './http-errors.js'

const safeLink = (value: unknown) => {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}
const commitSha = (value: unknown) => {
  const sha = githubString(value)
  if (!/^[0-9a-f]{40,64}$/u.test(sha)) throw new HttpError(502, 'Invalid GitHub commit SHA')
  return sha
}
const checkState = (status: unknown, conclusion: unknown): CheckState => {
  if (status !== 'completed')
    return ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(String(status))
      ? 'pending'
      : 'unknown'
  if (conclusion === 'success') return 'passed'
  if (conclusion === 'neutral' || conclusion === 'skipped') return 'skipped'
  return [
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'stale',
    'startup_failure',
  ].includes(String(conclusion))
    ? 'failed'
    : 'unknown'
}
export const summarizeChecks = (checks: PullRequestCheck[]): CiState => {
  if (!checks.length) return 'none'
  for (const state of ['failed', 'pending', 'unknown', 'skipped'] as const)
    if (checks.some((check) => check.state === state)) return state
  return 'passed'
}

export const createGitHubClient = (request: GitHubRequest = requestGitHub) => ({
  async find(cwd: string, repository: string, branch: string, baseBranch: string) {
    const query = new URLSearchParams({
      state: 'all',
      head: `${repository.split('/')[0]}:${branch}`,
      base: baseBranch,
      per_page: '100',
    })
    const pulls = githubArray(await request(cwd, `repos/${repository}/pulls?${query}`))
    if (pulls.length > 1)
      throw new HttpError(
        409,
        'Multiple pull requests match this branch. Link the intended pull request explicitly.'
      )
    return pulls[0] ? githubNumber(githubObject(pulls[0]).number) : null
  },
  async create(
    cwd: string,
    repository: string,
    input: { branch: string; baseBranch: string; title: string; body: string }
  ) {
    const result = githubObject(
      await request(cwd, `repos/${repository}/pulls`, {
        body: {
          head: input.branch,
          base: input.baseBranch,
          title: input.title,
          body: input.body,
          draft: true,
        },
      })
    )
    return githubNumber(result.number)
  },
  async read(cwd: string, repository: string, number: number): Promise<PullRequestSnapshot> {
    const root = `repos/${repository}`
    const pull = githubObject(await request(cwd, `${root}/pulls/${number}`))
    const head = githubObject(pull.head)
    const base = githubObject(pull.base)
    if (
      githubNumber(pull.number) !== number ||
      githubString(githubObject(head.repo).full_name).toLowerCase() !== repository.toLowerCase() ||
      githubString(githubObject(base.repo).full_name).toLowerCase() !== repository.toLowerCase()
    )
      throw new HttpError(409, 'The pull request repository changed.')
    const headSha = commitSha(head.sha)
    const [checkPages, statusPages] = await Promise.all([
      request(cwd, `${root}/commits/${headSha}/check-runs?filter=latest&per_page=100`, {
        paginate: true,
      }),
      request(cwd, `${root}/commits/${headSha}/statuses?per_page=100`, { paginate: true }),
    ])
    const checks: PullRequestCheck[] = githubArray(checkPages).flatMap((page) =>
      githubArray(githubObject(page).check_runs).map((item) => {
        const check = githubObject(item)
        if (commitSha(check.head_sha) !== headSha)
          throw new HttpError(502, 'CI evidence belongs to a different commit.')
        return {
          id: `check:${githubNumber(check.id)}`,
          name: githubString(check.name),
          state: checkState(check.status, check.conclusion),
          url: safeLink(check.details_url ?? check.html_url),
        }
      })
    )
    // The statuses endpoint returns newest first; earlier contexts must not override them.
    const seen = new Set<string>()
    for (const item of githubArray(statusPages).flatMap(githubArray)) {
      const status = githubObject(item)
      const name = githubString(status.context)
      if (seen.has(name)) continue
      seen.add(name)
      const state: CheckState =
        status.state === 'success'
          ? 'passed'
          : status.state === 'pending'
            ? 'pending'
            : status.state === 'failure' || status.state === 'error'
              ? 'failed'
              : 'unknown'
      checks.push({ id: `status:${name}`, name, state, url: safeLink(status.target_url) })
    }
    if (pull.state !== 'open' && pull.state !== 'closed')
      throw new HttpError(502, 'Unknown GitHub pull request state')
    return {
      number: githubNumber(pull.number),
      url: `https://github.com/${repository}/pull/${number}`,
      title: githubString(pull.title),
      state: pull.merged_at ? 'merged' : pull.state,
      draft: pull.draft === true,
      headSha,
      headBranch: githubString(head.ref),
      baseSha: commitSha(base.sha),
      baseBranch: githubString(base.ref),
      ciState: summarizeChecks(checks),
      checks,
      checkedAt: Date.now(),
    }
  },
})
export type GitHubClient = ReturnType<typeof createGitHubClient>
