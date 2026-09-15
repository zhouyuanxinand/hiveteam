import { execFile } from 'node:child_process'
import { HttpError } from './http-errors.js'

export type GitHubRequest = (
  cwd: string,
  endpoint: string,
  options?: { body?: Record<string, unknown>; paginate?: boolean }
) => Promise<unknown>

/** Credentials remain in the user's GitHub CLI; Hive never reads or stores a token. */
export const requestGitHub: GitHubRequest = (cwd, endpoint, options = {}) =>
  new Promise((resolve, reject) => {
    const args = [
      'api',
      '--hostname',
      'github.com',
      '--method',
      options.body ? 'POST' : 'GET',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
      endpoint,
      ...(options.body ? ['--input', '-'] : []),
      ...(options.paginate ? ['--paginate', '--slurp'] : []),
    ]
    const child = execFile(
      'gh',
      args,
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new HttpError(
              502,
              error.code === 'ENOENT'
                ? 'GitHub CLI is unavailable. Install gh and sign in with gh auth login.'
                : `GitHub CLI request failed: ${(stderr.trim() || error.message).slice(0, 4000)}`
            )
          )
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch (cause) {
          reject(new HttpError(502, `GitHub returned invalid JSON: ${String(cause)}`))
        }
      }
    )
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      // An early CLI exit reports its actual error through the callback above.
      if (error.code !== 'EPIPE') reject(error)
    })
    child.stdin?.end(options.body ? JSON.stringify(options.body) : undefined)
  })

export const githubObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(502, 'Unexpected GitHub response object')
  return value as Record<string, unknown>
}
export const githubString = (value: unknown): string => {
  if (typeof value !== 'string') throw new HttpError(502, 'Unexpected GitHub response field')
  return value
}
export const githubArray = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new HttpError(502, 'Unexpected GitHub response list')
  return value
}
export const githubNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new HttpError(502, 'Unexpected GitHub pull request number')
  return value
}
