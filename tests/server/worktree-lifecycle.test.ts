import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runGit } from '../../src/server/git-command.js'
import { readMergeState } from '../../src/server/git-merge-state.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { commitDelivery, createDeliveryFixture, gitHead } from '../helpers/delivery-fixture.js'

const fixtures: Array<Awaited<ReturnType<typeof createDeliveryFixture>>> = []
afterEach(async () => {
  while (fixtures.length) await fixtures.pop()?.close()
})
const setup = async () => {
  const ctx = await createDeliveryFixture()
  fixtures.push(ctx)
  return ctx
}

test('merges the reviewed target into an isolated branch and requires fresh verification', async () => {
  const ctx = await setup()
  const delivery = await ctx.deliver()
  await delivery.verify()
  writeFileSync(join(ctx.project, 'upstream.txt'), 'Target change')
  const target = await commitDelivery(ctx.project, 'Update target')
  const path = `/api/ui/workspaces/${ctx.workspace.id}/workers/${delivery.worker.id}/branch-update`
  const preview = await (await ctx.request(path)).json()
  expect(preview).toMatchObject({ can_update: true, source_sha: delivery.sha, target_sha: target })
  expect((await ctx.request(path, { ...preview, action: 'update' }, false)).status).toBe(403)
  expect(
    (await ctx.request(path, { ...preview, action: 'update', target_sha: ctx.baseline })).status
  ).toBe(409)
  const updated = await ctx.request(path, { ...preview, action: 'update' })
  expect(await updated.json()).toMatchObject({
    reason: 'up_to_date',
    update: { state: 'complete' },
    can_update: false,
  })
  expect(updated.status).toBe(200)
  const merged = await gitHead(delivery.tree.checkoutPath)
  const parents = (
    await runGit(delivery.tree.checkoutPath, ['rev-list', '--parents', '-n', '1', 'HEAD'])
  )
    .trim()
    .split(' ')
  expect(parents).toEqual([merged, delivery.sha, target])
  expect(readFileSync(join(delivery.tree.checkoutPath, 'upstream.txt'), 'utf8')).toBe(
    'Target change'
  )
  expect(await gitHead(ctx.project)).toBe(target)
  expect(await (await ctx.request(`${delivery.path}/verifications`)).json()).toMatchObject({
    accepted: false,
    stale_reason: 'code_changed',
    can_run: true,
  })
  expect((await (await ctx.request('/api/ui/delivery-queue')).json()).items[0].state).toBe('verify')
}, 90_000)

test('persists real conflicts, blocks PTY and verification, and supports abort and reviewed resolution after restart', async () => {
  const ctx = await setup()
  const delivery = await ctx.deliver()
  await delivery.verify()
  writeFileSync(join(ctx.project, 'value.txt'), 'upstream')
  const target = await commitDelivery(ctx.project, 'Conflicting target change')
  const path = `/api/ui/workspaces/${ctx.workspace.id}/workers/${delivery.worker.id}/branch-update`
  const update = () =>
    ctx.request(path, { action: 'update', source_sha: delivery.sha, target_sha: target })
  const conflicted = await (await update()).json()
  expect(conflicted).toMatchObject({
    reason: 'merge_in_progress',
    conflicts: ['value.txt'],
    can_abort: true,
    can_continue: false,
    update: { state: 'conflicted' },
  })
  expect(await readMergeState(delivery.tree.checkoutPath)).toBe('MERGE_HEAD')
  expect(readFileSync(join(delivery.tree.checkoutPath, 'value.txt'), 'utf8')).toContain('<<<<<<<')
  expect(await (await ctx.request(`${delivery.path}/verifications`)).json()).toMatchObject({
    accepted: false,
    can_run: false,
  })
  ctx.server.store.configureAgentLaunch(ctx.workspace.id, delivery.worker.id, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  await expect(
    ctx.server.store.startAgent(ctx.workspace.id, delivery.worker.id, {
      hivePort: new URL(ctx.server.baseUrl).port,
    })
  ).rejects.toThrow('Git operation')
  expect(
    ctx.server.store.getActiveRunByAgentId(ctx.workspace.id, delivery.worker.id)
  ).toBeUndefined()
  await ctx.restart()
  expect(await (await ctx.request(path)).json()).toMatchObject({
    can_abort: true,
    conflicts: ['value.txt'],
  })
  expect(
    (await ctx.request(path, { action: 'continue', source_sha: delivery.sha, target_sha: target }))
      .status
  ).toBe(409)
  expect(
    (await ctx.request(path, { action: 'abort', source_sha: delivery.sha, target_sha: target }))
      .status
  ).toBe(200)
  expect(await gitHead(delivery.tree.checkoutPath)).toBe(delivery.sha)
  expect(await readMergeState(delivery.tree.checkoutPath)).toBeNull()
  expect(readFileSync(join(delivery.tree.checkoutPath, 'value.txt'), 'utf8')).toBe('delivered')
  expect((await update()).status).toBe(200)
  writeFileSync(join(delivery.tree.checkoutPath, 'value.txt'), 'delivered')
  await runGit(delivery.tree.checkoutPath, ['add', 'value.txt'])
  const resolved = await (await ctx.request(path)).json()
  expect(resolved).toMatchObject({ can_continue: true, can_abort: true, conflicts: [] })
  const continued = await ctx.request(path, {
    action: 'continue',
    source_sha: delivery.sha,
    target_sha: target,
  })
  expect(await continued.json()).toMatchObject({ update: { state: 'complete' }, can_abort: false })
  expect(continued.status).toBe(200)
  expect(await readMergeState(delivery.tree.checkoutPath)).toBeNull()
  expect(await gitHead(delivery.tree.checkoutPath)).not.toBe(delivery.sha)
  expect(await (await ctx.request(`${delivery.path}/verifications`)).json()).toMatchObject({
    can_run: true,
    accepted: false,
  })
}, 90_000)

test('retains deleted workers, refuses unintegrated or dirty directories, and removes only a clean owned checkout while keeping its branch', async () => {
  const ctx = await setup()
  const delivery = await ctx.deliver()
  await delivery.verify()
  expect((await (await ctx.request('/api/ui/worktree-resources')).json()).total).toBe(0)
  ctx.server.store.deleteWorker(ctx.workspace.id, delivery.worker.id)
  const list = async () => (await (await ctx.request('/api/ui/worktree-resources')).json()).items
  expect((await list())[0]).toMatchObject({
    id: delivery.worker.id,
    can_remove: false,
    reason: 'not_integrated',
  })
  const remove = (head_sha = delivery.sha) =>
    ctx.request(`/api/ui/worktree-resources/${delivery.worker.id}/remove`, {
      head_sha,
      target_sha: delivery.sha,
    })
  expect((await remove()).status).toBe(409)
  await runGit(ctx.project, ['merge', '--ff-only', delivery.sha])
  writeFileSync(join(delivery.tree.checkoutPath, 'preserve.txt'), 'User file')
  expect((await list())[0].reason).toBe('uncommitted_changes')
  expect((await remove()).status).toBe(409)
  expect(readFileSync(join(delivery.tree.checkoutPath, 'preserve.txt'), 'utf8')).toBe('User file')
  unlinkSync(join(delivery.tree.checkoutPath, 'preserve.txt'))
  await ctx.restart()
  expect((await list())[0]).toMatchObject({
    can_remove: true,
    head_sha: delivery.sha,
    target_sha: delivery.sha,
  })
  expect((await remove(ctx.baseline)).status).toBe(409)
  expect((await remove()).status).toBe(200)
  expect(existsSync(delivery.tree.checkoutPath)).toBe(false)
  expect(
    (await runGit(ctx.project, ['rev-parse', `refs/heads/${delivery.tree.branch}`])).trim()
  ).toBe(delivery.sha)
  expect(readFileSync(join(ctx.project, 'value.txt'), 'utf8')).toBe('delivered')
  expect(await list()).toEqual([])
}, 90_000)

test('refuses cleanup when a retained resource points outside its owned root', async () => {
  const ctx = await setup()
  const { worker, tree } = await ctx.createWorker()
  ctx.server.store.deleteWorker(ctx.workspace.id, worker.id)
  const db = openRuntimeDatabase(ctx.dataDir)
  try {
    db.prepare('UPDATE worktree_resources SET checkout_path = ? WHERE worker_id = ?').run(
      ctx.project,
      worker.id
    )
  } finally {
    db.close()
  }
  const response = await ctx.request(`/api/ui/worktree-resources/${worker.id}/remove`, {
    head_sha: ctx.baseline,
    target_sha: ctx.baseline,
  })
  expect(response.status).toBe(409)
  expect(existsSync(tree.checkoutPath)).toBe(true)
  expect(readFileSync(join(ctx.project, 'value.txt'), 'utf8')).toBe('initial')
}, 60_000)

test('reconciles cleanup interrupted after Git removed the directory while retaining the branch', async () => {
  const ctx = await setup()
  const { worker, tree } = await ctx.createWorker()
  ctx.server.store.deleteWorker(ctx.workspace.id, worker.id)
  const preview = await ctx.server.store.worktreeResources.view(worker.id)
  expect(preview.can_remove).toBe(true)
  const db = openRuntimeDatabase(ctx.dataDir)
  try {
    db.prepare("UPDATE worktree_resources SET state = 'removing' WHERE worker_id = ?").run(
      worker.id
    )
  } finally {
    db.close()
  }
  await runGit(ctx.project, ['worktree', 'remove', tree.checkoutPath])
  await ctx.restart()
  expect((await (await ctx.request('/api/ui/worktree-resources')).json()).total).toBe(0)
  expect((await runGit(ctx.project, ['rev-parse', `refs/heads/${tree.branch}`])).trim()).toBe(
    ctx.baseline
  )
}, 60_000)
