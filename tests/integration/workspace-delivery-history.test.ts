import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Awaited<ReturnType<typeof startTestServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})
const fixture = async () => {
  const server = await startTestServer()
  servers.push(server)
  const path = join(server.dataDir, 'project')
  mkdirSync(path)
  const workspace = server.store.createWorkspace(path, 'History')
  const worker = server.store.addWorker(workspace.id, { name: 'Reader', role: 'coder' })
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  const insert =
    db.prepare(`INSERT INTO dispatches(id,workspace_id,to_agent_id,text,status,created_at,report_outcome,report_revision,accepted_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
  const ids: string[] = []
  db.transaction(() => {
    for (let i = 1; i <= 150; i++) {
      const id = randomUUID()
      ids.push(id)
      insert.run(
        id,
        workspace.id,
        worker.id,
        `任务 ${i}`,
        i === 150 ? 'queued' : 'reported',
        i,
        i === 149 ? 'blocked' : 'success',
        1,
        i <= 145 ? i : null
      )
    }
  })()
  db.close()
  const cookie = await getUiCookie(server.baseUrl)
  const get = (query = '') =>
    fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/delivery?${query}`, {
      headers: { cookie },
    })
  return { server, workspace, worker, cookie, get, ids }
}

test('150 dispatches retain full totals, latest tasks and the legacy ascending order', async () => {
  const f = await fixture()
  const small = await (await f.get('limit=1')).json()
  const large = await (await f.get('limit=100')).json()
  expect(small.items[0].id).toBe(f.ids[149])
  expect(small.summary).toEqual({ total: 150, active: 1, waiting: 3, attention: 1 })
  expect(large.summary).toEqual(small.summary)
  const attention = await (await f.get('filter=attention')).json()
  expect(attention.filtered_total).toBe(1)
  expect(attention.items.map((item: { id: string }) => item.id)).toEqual([f.ids[148]])
  expect(attention.summary).toEqual(small.summary)
  const old = await fetch(
    `${f.server.baseUrl}/api/ui/workspaces/${f.workspace.id}/dispatches?limit=2`,
    { headers: { cookie: f.cookie } }
  )
  expect((await old.json()).map((item: { id: string }) => item.id)).toEqual(f.ids.slice(0, 2))
})

test('new dispatches do not move the cursor or duplicate existing history across pages', async () => {
  const f = await fixture()
  let page = await (await f.get('limit=37')).json()
  const collected: string[] = page.items.map((item: { id: string }) => item.id)
  const db = new Database(join(f.server.dataDir, 'runtime.sqlite'))
  const extra = randomUUID()
  db.prepare(
    `INSERT INTO dispatches(id,workspace_id,to_agent_id,text,status,created_at) VALUES(?,?,?,'new','queued',?)`
  ).run(extra, f.workspace.id, f.worker.id, Date.now())
  db.close()
  while (page.next_cursor) {
    page = await (await f.get(`limit=37&cursor=${encodeURIComponent(page.next_cursor)}`)).json()
    collected.push(...page.items.map((item: { id: string }) => item.id))
  }
  expect(collected).toEqual([...f.ids].reverse())
  expect(new Set(collected).size).toBe(150)
  expect(page.summary.total).toBe(151)
  expect((await (await f.get()).json()).items[0].id).toBe(extra)
})

test('search is literal and cursor scope and anonymous access are checked', async () => {
  const f = await fixture()
  const found = await (await f.get(`query=${encodeURIComponent('任务 150')}`)).json()
  expect(found.items.map((item: { id: string }) => item.id)).toEqual([f.ids[149]])
  const first = await (await f.get('limit=1')).json()
  expect((await f.get(`filter=active&cursor=${first.next_cursor}`)).status).toBe(400)
  expect((await f.get('cursor=malformed')).status).toBe(400)
  const anonymous = await fetch(`${f.server.baseUrl}/api/ui/workspaces/${f.workspace.id}/delivery`)
  expect(anonymous.status).toBe(403)
})
