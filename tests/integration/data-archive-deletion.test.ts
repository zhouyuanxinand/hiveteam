import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

test.each([
  'worker',
  'workspace',
] as const)('deleting an archived %s rolls back on failure and preserves unrelated history and source files', async (scope) => {
  const server = await startTestServer()
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  try {
    const cookie = await getUiCookie(server.baseUrl)
    const fixture = async (name: string) => {
      const path = join(server.dataDir, name)
      mkdirSync(path)
      writeFileSync(join(path, 'keep.txt'), name)
      const workspace = server.store.createWorkspace(path, name)
      const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
      const dispatch = await server.store.dispatchTask(workspace.id, worker.id, 'completed')
      server.store.reportTask(workspace.id, worker.id, {
        dispatchId: dispatch.id,
        requireActiveRun: true,
        outcome: 'success',
        text: 'Reviewed result',
      })
      server.store.acceptDispatchReport(workspace.id, dispatch.id, 1)
      db.prepare('UPDATE report_outbox SET delivered_at=? WHERE dispatch_id=?').run(
        Date.now(),
        dispatch.id
      )
      db.prepare("UPDATE message_deliveries SET state='resolved' WHERE dispatch_id=?").run(
        dispatch.id
      )
      const url = `${server.baseUrl}/api/ui/workspaces/${workspace.id}/retention`
      const preview = await (await fetch(url, { headers: { cookie } })).json()
      const operation = randomUUID()
      const archived = await fetch(url, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          operation_id: operation,
          expected_version: preview.version,
          dispatch_ids: [dispatch.id],
          action: 'archive',
          confirm: true,
        }),
      })
      expect(archived.status, await archived.clone().text()).toBe(200)
      return { workspace, worker, dispatch, path, operation }
    }
    const selected = await fixture('selected')
    const other = await fixture('unrelated')
    const selectedPath = `/api/workspaces/${selected.workspace.id}${scope === 'worker' ? `/workers/${selected.worker.id}` : ''}`
    const remove = () =>
      fetch(server.baseUrl + selectedPath, { method: 'DELETE', headers: { cookie } })
    db.exec(
      "CREATE TRIGGER reject_dispatch_delete BEFORE DELETE ON dispatches BEGIN SELECT RAISE(ABORT,'synthetic delete unavailable'); END"
    )
    const rejected = await remove()
    expect(rejected.status).toBe(500)
    expect(server.store.getDispatch(selected.workspace.id, selected.dispatch.id)?.reportText).toBe(
      'Reviewed result'
    )
    expect(server.store.listWorkers(selected.workspace.id).map((worker) => worker.id)).toContain(
      selected.worker.id
    )
    expect(db.prepare('SELECT COUNT(*) AS total FROM dispatch_archives').get()).toEqual({
      total: 2,
    })
    db.exec('DROP TRIGGER reject_dispatch_delete')

    const deleted = await remove()
    expect(deleted.status, await deleted.clone().text()).toBe(204)
    expect(db.prepare('SELECT dispatch_id FROM dispatch_archives').all()).toEqual([
      { dispatch_id: other.dispatch.id },
    ])
    expect(db.prepare('SELECT id FROM dispatches').all()).toEqual([{ id: other.dispatch.id }])
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(server.store.getDispatch(other.workspace.id, other.dispatch.id)?.reportText).toBe(
      'Reviewed result'
    )
    expect(readFileSync(join(selected.path, 'keep.txt'), 'utf8')).toBe('selected')
    const remainingOperations = db
      .prepare('SELECT id FROM data_archive_operations WHERE workspace_id=?')
      .all(selected.workspace.id)
    expect(remainingOperations).toEqual(scope === 'worker' ? [{ id: selected.operation }] : [])
  } finally {
    db.close()
    await server.close()
  }
})
