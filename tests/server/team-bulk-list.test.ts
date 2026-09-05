import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const createWorkspace = async (baseUrl: string, cookie: string, name: string) => {
  const workspacePath = join(tmpdir(), `hive-team-bulk-${name}-${Date.now()}`)
  mkdirSync(workspacePath, { recursive: true })
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name, path: workspacePath }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

describe('bulk team listing', () => {
  test('returns team lists for multiple workspaces in one request', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const alpha = await createWorkspace(server.baseUrl, cookie, 'alpha')
    const beta = await createWorkspace(server.baseUrl, cookie, 'beta')

    const addWorker = async (workspaceId: string, name: string) => {
      const response = await fetch(`${server.baseUrl}/api/workspaces/${workspaceId}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name, role: 'coder' }),
      })
      expect(response.status).toBe(201)
    }
    await addWorker(alpha.id, 'Alice')
    await addWorker(beta.id, 'Beth')
    await addWorker(beta.id, 'Boris')

    const response = await fetch(
      `${server.baseUrl}/api/ui/team?workspace_ids=${alpha.id},${beta.id},missing-workspace`,
      { headers: { cookie } }
    )
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      workers_by_workspace_id: Record<
        string,
        Array<{ id: string; name: string; pending_task_count: number }>
      >
    }

    expect(payload.workers_by_workspace_id[alpha.id]?.map((worker) => worker.name)).toEqual([
      'Alice',
    ])
    expect(payload.workers_by_workspace_id[beta.id]?.map((worker) => worker.name)).toEqual([
      'Beth',
      'Boris',
    ])
    // A workspace that vanished mid-poll reports an empty list instead of
    // failing the whole batch.
    expect(payload.workers_by_workspace_id['missing-workspace']).toEqual([])
  })

  test('matches the per-workspace endpoint for the same workspace', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const alpha = await createWorkspace(server.baseUrl, cookie, 'solo')
    await fetch(`${server.baseUrl}/api/workspaces/${alpha.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Alice', role: 'coder' }),
    })

    const single = await fetch(`${server.baseUrl}/api/ui/workspaces/${alpha.id}/team`, {
      headers: { cookie },
    })
    const singlePayload = (await single.json()) as unknown[]

    const bulk = await fetch(`${server.baseUrl}/api/ui/team?workspace_ids=${alpha.id}`, {
      headers: { cookie },
    })
    const bulkPayload = (await bulk.json()) as {
      workers_by_workspace_id: Record<string, unknown[]>
    }

    expect(bulkPayload.workers_by_workspace_id[alpha.id]).toEqual(singlePayload)
  })

  test('rejects unauthenticated callers', async () => {
    const server = await startTestServer()
    servers.push(server)

    const response = await fetch(`${server.baseUrl}/api/ui/team?workspace_ids=x`)
    expect(response.status).toBe(403)
  })
})
