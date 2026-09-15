import { existsSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import { runGit } from '../../src/server/git-command.js'
import { createDeliveryFixture } from '../helpers/delivery-fixture.js'
import { createGitHubFixture } from '../helpers/github-fixture.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.()
})

test('rejects publication during workspace deletion and retains the local working directory', async () => {
  const github = await createGitHubFixture()
  cleanup.push(github.close)
  const ctx = await createDeliveryFixture(github.client)
  cleanup.push(ctx.close)
  const delivery = await ctx.deliver()
  await delivery.verify()
  github.state.headSha = delivery.sha
  github.state.baseSha = ctx.baseline
  github.state.branch = delivery.tree.branch
  const path = `${delivery.path}/pull-request`
  const preview = await (await ctx.request(path)).json()
  expect(preview.can_publish).toBe(true)
  const cookie = await getUiCookie(ctx.server.baseUrl)

  // Keep the real verification shutdown, but hold its completion so both HTTP
  // requests overlap deterministically without relying on PTY exit timing.
  const shutdown = ctx.server.store.verifications.deleteWorkspace
  let deleting = false
  let release = () => {}
  const resume = new Promise<void>((resolve) => {
    release = resolve
  })
  const gate = vi
    .spyOn(ctx.server.store.verifications, 'deleteWorkspace')
    .mockImplementation(async (workspaceId) => {
      await shutdown(workspaceId)
      deleting = true
      await resume
    })
  const deletion = fetch(`${ctx.server.baseUrl}/api/workspaces/${ctx.workspace.id}`, {
    method: 'DELETE',
    headers: { cookie },
  })
  try {
    await vi.waitFor(() => expect(deleting).toBe(true))
    const response = await ctx.request(path, {
      ...preview,
      title: 'Deliver change',
      body: '',
    })
    expect(response.status).toBe(409)
    expect(
      (
        await runGit(ctx.bare, [
          'for-each-ref',
          '--format=%(refname)',
          `refs/heads/${delivery.tree.branch}`,
        ])
      ).trim()
    ).toBe('')
    expect(github.state.exists).toBe(false)
    expect(
      (await (await ctx.request('/api/workspaces')).json()).map((item: { id: string }) => item.id)
    ).toContain(ctx.workspace.id)
  } finally {
    release()
    try {
      expect((await deletion).status).toBe(204)
    } finally {
      gate.mockRestore()
    }
  }
  expect(await (await ctx.request('/api/workspaces')).json()).toEqual([])
  expect(existsSync(delivery.tree.checkoutPath)).toBe(true)
}, 90_000)
