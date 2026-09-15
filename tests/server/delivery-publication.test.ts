import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runGit } from '../../src/server/git-command.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { createDeliveryFixture, gitHead } from '../helpers/delivery-fixture.js'
import { createGitHubFixture } from '../helpers/github-fixture.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.()
})
const setup = async () => {
  const github = await createGitHubFixture()
  cleanup.push(github.close)
  const ctx = await createDeliveryFixture(github.client)
  cleanup.push(ctx.close)
  const delivery = await ctx.deliver()
  github.state.headSha = delivery.sha
  github.state.baseSha = ctx.baseline
  github.state.branch = delivery.tree.branch
  const path = `${delivery.path}/pull-request`
  const preview = async () => (await ctx.request(path)).json()
  const publish = async () =>
    ctx.request(path, {
      ...(await preview()),
      title: 'Deliver change',
      body: 'Verified with node check.cjs',
    })
  return { ctx, github, delivery, path, preview, publish }
}

test('keeps the PR receipt when initial CI retrieval fails and reconciles an interrupted publication after restart', async () => {
  const { ctx, github, delivery, path, preview, publish } = await setup()
  await delivery.verify()
  github.state.failChecks = true
  const response = await publish()
  expect(await response.json()).toMatchObject({
    can_publish: false,
    reason: 'published',
    publication: { number: 7, state: 'published', snapshot: null, error: 'GitHub unavailable' },
  })
  expect(response.status).toBe(200)
  await ctx.restart()
  expect((await preview()).publication.number).toBe(7)
  github.state.failChecks = false
  expect((await ctx.request(`${path}/refresh`, {})).status).toBe(200)
  const db = openRuntimeDatabase(ctx.dataDir)
  try {
    db.prepare(
      "UPDATE dispatch_pull_requests SET state = 'publishing', number = NULL, snapshot = NULL WHERE dispatch_id = ?"
    ).run(delivery.dispatch.id)
  } finally {
    db.close()
  }
  await ctx.restart()
  expect((await preview()).publication).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('interrupted'),
  })
  expect((await publish()).status).toBe(200)
  expect((await preview()).publication).toMatchObject({
    number: 7,
    state: 'published',
    error: null,
  })
  expect(github.state.creates).toBe(1)
}, 90_000)

test('publishes exactly the accepted SHA and persists CI, failure recovery, and merge status through real HTTP and Git', async () => {
  const { ctx, github, delivery, path, preview, publish } = await setup()
  expect((await ctx.request(path, undefined, false)).status).toBe(403)
  expect(await preview()).toMatchObject({ can_publish: false, reason: 'accept_required' })
  expect((await publish()).status).toBe(400)
  expect(
    (
      await ctx.request(path, {
        ...(await preview()),
        verification_id: 'not-accepted',
        title: 'Deliver',
        body: '',
      })
    ).status
  ).toBe(409)
  const verificationId = await delivery.verify()
  expect(await preview()).toMatchObject({
    can_publish: true,
    head_sha: delivery.sha,
    verification_id: verificationId,
  })
  const response = await publish()
  expect(await response.json()).toMatchObject({
    reason: 'published',
    publication: {
      state: 'published',
      number: 7,
      snapshot: { ci_state: 'passed', head_sha: delivery.sha, draft: true },
    },
  })
  expect(response.status).toBe(200)
  expect((await runGit(ctx.bare, ['rev-parse', `refs/heads/${delivery.tree.branch}`])).trim()).toBe(
    delivery.sha
  )
  expect(await gitHead(ctx.project)).toBe(ctx.baseline)
  expect(github.state.draft).toBe(true)
  expect(new Set(github.state.requestedShas)).toEqual(new Set([delivery.sha]))
  await ctx.restart()
  expect((await preview()).publication.number).toBe(7)
  github.state.conclusion = 'failure'
  expect(
    (await (await ctx.request(`${path}/refresh`, {})).json()).publication.snapshot.ci_state
  ).toBe('failed')
  expect((await (await ctx.request('/api/ui/delivery-queue')).json()).items[0].state).toBe(
    'ci_failed'
  )
  github.state.failChecks = true
  expect((await ctx.request(`${path}/refresh`, {})).status).toBe(500)
  expect((await preview()).publication).toMatchObject({
    state: 'published',
    error: 'GitHub unavailable',
    snapshot: { ci_state: 'failed' },
  })
  github.state.failChecks = false
  github.state.checks = false
  expect(
    (await (await ctx.request(`${path}/refresh`, {})).json()).publication.snapshot.ci_state
  ).toBe('none')
  github.state.merged = true
  github.state.pullState = 'closed'
  expect((await (await ctx.request(`${path}/refresh`, {})).json()).publication.snapshot.state).toBe(
    'merged'
  )
  expect((await (await ctx.request('/api/ui/delivery-queue')).json()).total).toBe(0)
  expect(github.state.creates).toBe(1)
}, 90_000)

test('rejects dirty or changed previews and reconciles an existing PR without another creation', async () => {
  const { ctx, github, delivery, path, preview, publish } = await setup()
  await delivery.verify()
  const ready = await preview()
  writeFileSync(join(delivery.tree.checkoutPath, 'value.txt'), 'unreviewed')
  expect((await ctx.request(path, { ...ready, title: 'Deliver', body: '' })).status).toBe(409)
  expect(github.state.creates).toBe(0)
  writeFileSync(join(delivery.tree.checkoutPath, 'value.txt'), 'delivered')
  expect(
    (
      await ctx.request(path, {
        ...ready,
        repository: 'example/different',
        title: 'Deliver',
        body: '',
      })
    ).status
  ).toBe(409)
  github.state.exists = true
  expect((await publish()).status).toBe(200)
  expect(github.state.creates).toBe(0)
  github.state.headSha = 'c'.repeat(40)
  const changed = await (await ctx.request(`${path}/refresh`, {})).json()
  expect(changed.publication.snapshot.head_sha).not.toBe(changed.head_sha)
  expect((await (await ctx.request('/api/ui/delivery-queue')).json()).items[0].state).toBe(
    'pull_request'
  )
}, 90_000)
