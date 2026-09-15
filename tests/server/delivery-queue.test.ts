import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { createDeliveryFixture } from '../helpers/delivery-fixture.js'

test('paginates across all workspaces, includes older blockers, and validates queue filters at the HTTP boundary', async () => {
  const ctx = await createDeliveryFixture()
  try {
    const secondPath = join(ctx.root, 'second')
    mkdirSync(secondPath)
    const second = ctx.server.store.createWorkspace(secondPath, 'Second workspace')
    const db = openRuntimeDatabase(ctx.dataDir)
    const oldest = randomUUID()
    try {
      const insert =
        db.prepare(`INSERT INTO dispatches (id, workspace_id, to_agent_id, text, status, created_at, report_outcome, report_revision, reported_at)
        VALUES (?, ?, ?, ?, 'reported', ?, ?, 1, ?)`)
      db.transaction(() => {
        for (let index = 0; index < 106; index += 1)
          insert.run(
            index === 0 ? oldest : randomUUID(),
            index === 105 ? second.id : ctx.workspace.id,
            'historical-worker',
            `Delivery ${index}`,
            index + 1,
            index === 0 ? 'blocked' : index === 105 ? 'failed' : 'success',
            index + 1
          )
      })()
    } finally {
      db.close()
    }
    const queue = (query = '') => ctx.request(`/api/ui/delivery-queue${query}`)
    expect((await ctx.request('/api/ui/delivery-queue', undefined, false)).status).toBe(403)
    for (const query of ['?limit=101', '?offset=-1', '?state=invalid'])
      expect((await queue(query)).status).toBe(400)
    const first = await (await queue()).json()
    expect(first).toMatchObject({
      total: 106,
      offset: 0,
      limit: 25,
      counts: { blocked: 2, verify: 104 },
    })
    expect(first.items[0]).toMatchObject({
      state: 'blocked',
      workspace_id: ctx.workspace.id,
      dispatch: { id: oldest, report_outcome: 'blocked' },
    })
    expect(first.items[0].dispatch.workspaceId).toBeUndefined()
    const ids = new Set<string>()
    for (const offset of [0, 25, 50, 75, 100]) {
      const page = await (await queue(`?offset=${offset}`)).json()
      for (const item of page.items) ids.add(item.dispatch.id)
    }
    expect(ids.size).toBe(106)
    const filtered = await (await queue(`?workspace_id=${second.id}&state=blocked`)).json()
    expect(filtered.total).toBe(1)
    expect(filtered.items[0]).toMatchObject({
      workspace_name: 'Second workspace',
      dispatch: { report_outcome: 'failed' },
    })
    await ctx.restart()
    expect((await (await queue('?offset=100')).json()).items).toHaveLength(6)
  } finally {
    await ctx.close()
  }
}, 60_000)
