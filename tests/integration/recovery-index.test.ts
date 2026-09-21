import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, test, vi } from 'vitest'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Awaited<ReturnType<typeof startAuthorizedTestServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})
// Preparing 23 real dispatch baselines starts Git processes before the real agent lifecycle.
test('paged recovery reads all cross-day work and exact task positions, invalidates changes, and revokes worker cursors', async () => {
  const server = await startAuthorizedTestServer()
  servers.push(server)
  const workspace = server.store.createWorkspace(server.dataDir, 'Recovery')
  const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  const other = server.store.addWorker(workspace.id, { name: 'Bob', role: 'tester' })
  const dispatches = await Promise.all(
    Array.from({ length: 22 }, (_, i) =>
      server.store.dispatchTask(workspace.id, worker.id, `pending ${i}`)
    )
  )
  await server.store.dispatchTask(workspace.id, other.id, 'private Bob work')
  mkdirSync(join(server.dataDir, '.hive'), { recursive: true })
  writeFileSync(
    join(server.dataDir, '.hive/tasks.md'),
    Array.from({ length: 40 }, (_, i) => `- [ ] task ${i} @Alice`).join('\n') +
      '\n- [ ] private Bob task @Bob\n'
  )
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  db.prepare('UPDATE dispatches SET created_at=?').run(Date.now() - 2 * 86400000)
  db.close()
  const cookie = await getUiCookie(server.baseUrl),
    url = `${server.baseUrl}/api/ui/workspaces/${workspace.id}/recovery-index`
  const first = await (await fetch(`${url}?limit=7`, { headers: { cookie } })).json()
  const items = [...first.items]
  let cursor = first.next_cursor
  while (cursor) {
    const page = await (
      await fetch(`${url}?limit=7&cursor=${cursor}`, { headers: { cookie } })
    ).json()
    expect(page.snapshot).toBe(first.snapshot)
    items.push(...page.items)
    cursor = page.next_cursor
  }
  expect(first.total).toBe(64)
  expect(items.filter((item) => item.kind === 'dispatch').map((item) => item.id)).toEqual(
    expect.arrayContaining(dispatches.map((d) => d.id))
  )
  expect(items.filter((item) => item.kind === 'task').map((item) => item.line)).toEqual(
    Array.from({ length: 41 }, (_, i) => i + 1)
  )
  writeFileSync(join(server.dataDir, '.hive/tasks.md'), '- [ ] changed @Alice')
  const expired = await fetch(`${url}?cursor=${first.next_cursor}`, { headers: { cookie } })
  expect(expired.status).toBe(409)
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  const run = await server.store.startAgent(workspace.id, worker.id, {
    hivePort: new URL(server.baseUrl).port,
  })
  const token = server.store.peekAgentToken(worker.id)
  const read = (cursor?: string) =>
    fetch(`${server.baseUrl}/api/team/recovery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: worker.id,
        token,
        cursor,
        limit: 5,
      }),
    })
  const own = await (await read()).json()
  expect(own.scope).toBe('own')
  expect(own.total).toBe(23)
  expect(JSON.stringify(own)).not.toContain('private Bob')
  server.store.stopAgentRun(run.runId)
  await vi.waitFor(async () => expect((await read(own.next_cursor)).status).toBe(401), {
    timeout: 5000,
  })
}, 15_000)
