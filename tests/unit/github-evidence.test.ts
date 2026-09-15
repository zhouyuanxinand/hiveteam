import { expect, test } from 'vitest'
import { createGitHubClient } from '../../src/server/github-pull-requests.js'
import { parseGitHubRemote } from '../../src/server/github-remote.js'

const sha = 'a'.repeat(40)
const pull = {
  number: 1,
  title: 'Change',
  state: 'open',
  draft: true,
  merged_at: null,
  head: { sha, ref: 'worker', repo: { full_name: 'example/repo' } },
  base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'example/repo' } },
}
test('aggregates every check page and only the newest status per context', async () => {
  const client = createGitHubClient(async (_cwd, endpoint) => {
    if (endpoint.endsWith('/pulls/1')) return pull
    if (endpoint.includes('check-runs'))
      return [
        {
          check_runs: [
            { id: 1, name: 'build', head_sha: sha, status: 'completed', conclusion: 'success' },
          ],
        },
        {
          check_runs: [
            {
              id: 2,
              name: 'integration',
              head_sha: sha,
              status: 'completed',
              conclusion: 'failure',
              details_url: 'javascript:alert(1)',
            },
          ],
        },
      ]
    return [[{ context: 'deploy', state: 'pending' }], [{ context: 'deploy', state: 'success' }]]
  })
  const result = await client.read('.', 'example/repo', 1)
  expect(result.ciState).toBe('failed')
  expect(result.checks).toEqual([
    { id: 'check:1', name: 'build', state: 'passed', url: null },
    { id: 'check:2', name: 'integration', state: 'failed', url: null },
    { id: 'status:deploy', name: 'deploy', state: 'pending', url: null },
  ])
})
test('rejects evidence from another commit and distinguishes skipped checks from passing checks', async () => {
  let headSha = 'c'.repeat(40)
  const client = createGitHubClient(async (_cwd, endpoint) => {
    if (endpoint.endsWith('/pulls/1')) return pull
    return endpoint.includes('check-runs')
      ? [
          {
            check_runs: [
              {
                id: 1,
                name: 'build',
                head_sha: headSha,
                status: 'completed',
                conclusion: 'skipped',
              },
            ],
          },
        ]
      : [[]]
  })
  await expect(client.read('.', 'example/repo', 1)).rejects.toThrow('different commit')
  headSha = sha
  expect((await client.read('.', 'example/repo', 1)).ciState).toBe('skipped')
})
test('recognizes GitHub origin coordinates without accepting other hosts or extra URL content', () => {
  for (const remote of [
    'https://github.com/example/repo.git',
    'git@github.com:example/repo.git',
    'ssh://git@github.com/example/repo',
  ])
    expect(parseGitHubRemote(remote)).toBe('example/repo')
  for (const remote of [
    'https://github.com.attacker.test/example/repo',
    'https://example.com/repo',
    'https://github.com/example/repo?token=value',
  ])
    expect(parseGitHubRemote(remote)).toBeNull()
})
