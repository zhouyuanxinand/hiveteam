import { createServer } from 'node:http'
import { createGitHubClient } from '../../src/server/github-pull-requests.js'
import { listenOnFetchSafePort } from './test-server.js'

export const createGitHubFixture = async () => {
  const state = {
    exists: false,
    creates: 0,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    branch: '',
    pullState: 'open',
    merged: false,
    conclusion: 'success',
    failChecks: false,
    checks: true,
    commitStatus: 'success',
    requestedShas: [] as string[],
    draft: false,
  }
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname.endsWith('/pulls') && request.method === 'POST') {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const data = JSON.parse(body)
      state.branch = data.head
      state.draft = data.draft
      state.exists = true
      state.creates += 1
      response.end(JSON.stringify({ number: 7 }))
    } else if (url.pathname.endsWith('/pulls')) {
      response.end(JSON.stringify(state.exists ? [{ number: 7 }] : []))
    } else if (url.pathname.endsWith('/pulls/7')) {
      response.end(
        JSON.stringify({
          number: 7,
          title: 'Deliver change',
          draft: true,
          state: state.pullState,
          merged_at: state.merged ? '2026-09-15T00:00:00Z' : null,
          head: { sha: state.headSha, ref: state.branch, repo: { full_name: 'example/delivery' } },
          base: { sha: state.baseSha, ref: 'main', repo: { full_name: 'example/delivery' } },
        })
      )
    } else if (url.pathname.includes('/commits/')) {
      state.requestedShas.push(url.pathname.split('/')[5] ?? '')
      if (state.failChecks) {
        response.statusCode = 503
        response.end(JSON.stringify({ error: 'GitHub unavailable' }))
        return
      }
      if (url.pathname.endsWith('/check-runs'))
        response.end(
          JSON.stringify({
            check_runs: state.checks
              ? [
                  {
                    head_sha: state.headSha,
                    id: 1,
                    name: 'build',
                    status: 'completed',
                    conclusion: state.conclusion,
                    details_url: 'https://github.com/example/delivery/actions/runs/1',
                  },
                ]
              : [],
          })
        )
      else
        response.end(
          JSON.stringify(
            state.checks
              ? [
                  { context: 'deploy', state: state.commitStatus },
                  { context: 'deploy', state: 'failure' },
                ]
              : []
          )
        )
    } else {
      response.statusCode = 404
      response.end('{}')
    }
  })
  const port = await listenOnFetchSafePort(server)
  const client = createGitHubClient(async (_cwd, endpoint, options) => {
    const response = await fetch(`http://127.0.0.1:${port}/${endpoint}`, {
      method: options?.body ? 'POST' : 'GET',
      ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
    })
    if (!response.ok) throw new Error('GitHub unavailable')
    const value = await response.json()
    return options?.paginate ? [value] : value
  })
  return {
    state,
    client,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  }
}
