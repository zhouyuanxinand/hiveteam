import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from '../../src/server/sqlite.js'
import type { AttentionPage } from '../../src/shared/activity-attention.js'
import { startAuthorizedTestServer } from './test-server.js'
import { getUiCookie } from './ui-session.js'

export const createAttentionFixture = async () => {
  const server = await startAuthorizedTestServer()
  // Freeze the background pump so HTTP reads can be checked against exact durable receipts.
  server.store.dispatchDelivery.close()
  const path = join(server.dataDir, 'attention-project')
  mkdirSync(path)
  const workspace = server.store.createWorkspace(path, 'Attention project')
  const worker = server.store.addWorker(workspace.id, { name: 'Attention coder', role: 'coder' })
  const actor = `${workspace.id}:orchestrator`
  const cookie = await getUiCookie(server.baseUrl)
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  const request = (path: string, body?: object) =>
    fetch(server.baseUrl + path, {
      headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    })
  const get = (query = '', id = workspace.id) =>
    request(`/api/ui/workspaces/${id}/attention?${query}`)
  const page = async (query = ''): Promise<AttentionPage> => {
    const response = await get(query)
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
    return response.json() as Promise<AttentionPage>
  }
  const task = (text: string, protocol: 0 | 1 = 0) =>
    server.store.dispatchTask(workspace.id, worker.id, text, { messageProtocolVersion: protocol })
  const report = async (text: string, outcome: 'success' | 'blocked' = 'success') => {
    const dispatch = await task(text)
    server.store.reportTask(workspace.id, worker.id, {
      dispatchId: dispatch.id,
      text: `Completed: ${text}`,
      outcome,
      requireActiveRun: true,
    })
    const receipt = server.store.dispatchDelivery.records
      .list(workspace.id)
      .find((record) => record.dispatch_id === dispatch.id && record.kind === 'report')
    if (!receipt) throw new Error('Expected durable report receipt')
    return { dispatch, receipt }
  }
  return {
    server,
    workspace,
    worker,
    actor,
    cookie,
    db,
    request,
    get,
    page,
    task,
    report,
    async close() {
      db.close()
      await server.close()
    },
  }
}
