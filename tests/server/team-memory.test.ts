import { afterEach, describe, expect, test } from 'vitest'

import { TEAM_MEMORY_BODY_MAX_CHARS } from '../../src/shared/team-memory.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

describe('team memory', () => {
  test('UI can create, search, update, archive, and configure workspace memory', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace('/tmp/hiveteam-memory', 'Memory')
    const baseUrl = `${server.baseUrl}/api/ui/workspaces/${workspace.id}/memory`

    const createResponse = await fetch(baseUrl, {
      body: JSON.stringify({
        body: 'Use port 4310 for the local integration environment.',
        kind: 'decision',
        scope: 'workspace',
        tags: ['runtime', 'ports'],
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { id: string; pinned: boolean }
    expect(created).toMatchObject({ id: expect.any(String), pinned: false })

    const listResponse = await fetch(`${baseUrl}?status=active&query=4310`, {
      headers: { cookie },
    })
    expect(listResponse.status).toBe(200)
    await expect(listResponse.json()).resolves.toEqual([
      expect.objectContaining({
        body: 'Use port 4310 for the local integration environment.',
        kind: 'decision',
        tags: ['runtime', 'ports'],
      }),
    ])

    const pinResponse = await fetch(`${baseUrl}/${created.id}`, {
      body: JSON.stringify({ pinned: true }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PATCH',
    })
    expect(pinResponse.status).toBe(200)
    await expect(pinResponse.json()).resolves.toEqual(expect.objectContaining({ pinned: true }))

    const archiveResponse = await fetch(`${baseUrl}/${created.id}`, {
      body: JSON.stringify({ status: 'archived' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PATCH',
    })
    expect(archiveResponse.status).toBe(200)
    await expect(archiveResponse.json()).resolves.toEqual(
      expect.objectContaining({ status: 'archived' })
    )

    const settingsResponse = await fetch(`${baseUrl}/settings`, { headers: { cookie } })
    await expect(settingsResponse.json()).resolves.toEqual({ dream_enabled: false, enabled: true })

    const disableResponse = await fetch(`${baseUrl}/settings`, {
      body: JSON.stringify({ enabled: false }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(disableResponse.status).toBe(200)
    await expect(disableResponse.json()).resolves.toEqual({ dream_enabled: false, enabled: false })

    const enableDreamResponse = await fetch(`${baseUrl}/settings`, {
      body: JSON.stringify({ dream_enabled: true }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(enableDreamResponse.status).toBe(200)
    await expect(enableDreamResponse.json()).resolves.toEqual({
      dream_enabled: true,
      enabled: false,
    })
  })

  test('memory endpoints reject invalid kinds and require a UI session', async () => {
    const server = await startTestServer()
    servers.push(server)
    const workspace = server.store.createWorkspace('/tmp/hiveteam-memory-auth', 'Memory auth')
    const endpoint = `${server.baseUrl}/api/ui/workspaces/${workspace.id}/memory`

    const unauthorized = await fetch(endpoint)
    expect(unauthorized.status).toBe(403)

    const cookie = await getUiCookie(server.baseUrl)
    const invalid = await fetch(endpoint, {
      body: JSON.stringify({ body: 'Bad kind', kind: 'unknown' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(invalid.status).toBe(400)

    for (const body of ['', ' '.repeat(4), 'x'.repeat(TEAM_MEMORY_BODY_MAX_CHARS + 1)]) {
      const invalidBody = await fetch(endpoint, {
        body: JSON.stringify({ body, kind: 'fact' }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(invalidBody.status).toBe(400)
    }

    const missingProcedureReference = await fetch(endpoint, {
      body: JSON.stringify({
        body: 'Run the release checklist before deployment.',
        kind: 'procedure_ref',
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(missingProcedureReference.status).toBe(400)

    const invalidProcedureReference = await fetch(endpoint, {
      body: JSON.stringify({
        body: 'Run the release checklist before deployment.',
        kind: 'procedure_ref',
        procedure_ref: { id: '.hive/workflows/release-check.ts', type: 'unknown' },
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(invalidProcedureReference.status).toBe(400)
  })

  test('stores and searches a structured procedure reference', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace('/tmp/hiveteam-memory-procedure', 'Procedures')
    const endpoint = `${server.baseUrl}/api/ui/workspaces/${workspace.id}/memory`

    const createResponse = await fetch(endpoint, {
      body: JSON.stringify({
        body: 'Run the release checklist before deploying.',
        kind: 'procedure_ref',
        procedure_ref: {
          id: '.hive/workflows/release-check.ts',
          title: 'Release checklist',
          type: 'workflow',
        },
        scope: 'workspace',
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { id: string; procedure_ref: unknown }
    expect(created.procedure_ref).toEqual({
      id: '.hive/workflows/release-check.ts',
      title: 'Release checklist',
      type: 'workflow',
    })

    const listResponse = await fetch(`${endpoint}?status=active&query=release-check`, {
      headers: { cookie },
    })
    await expect(listResponse.json()).resolves.toEqual([
      expect.objectContaining({
        id: created.id,
        procedure_ref: {
          id: '.hive/workflows/release-check.ts',
          title: 'Release checklist',
          type: 'workflow',
        },
      }),
    ])

    const invalidUpdate = await fetch(`${endpoint}/${created.id}`, {
      body: JSON.stringify({ procedure_ref: null }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PATCH',
    })
    expect(invalidUpdate.status).toBe(400)
  })

  test('user-scoped memory is shared across workspaces and can return to workspace scope', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const first = server.store.createWorkspace('/tmp/hiveteam-memory-first', 'First')
    const second = server.store.createWorkspace('/tmp/hiveteam-memory-second', 'Second')
    const firstUrl = `${server.baseUrl}/api/ui/workspaces/${first.id}/memory`
    const secondUrl = `${server.baseUrl}/api/ui/workspaces/${second.id}/memory`

    const createResponse = await fetch(firstUrl, {
      body: JSON.stringify({
        body: 'Always use concise Chinese UI copy.',
        kind: 'preference',
        scope: 'user',
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    const created = (await createResponse.json()) as { id: string; workspace_id: string | null }
    expect(createResponse.status).toBe(201)
    expect(created.workspace_id).toBeNull()

    const shared = (await (
      await fetch(`${secondUrl}?scope=user`, { headers: { cookie } })
    ).json()) as Array<{ id: string }>
    expect(shared).toEqual([expect.objectContaining({ id: created.id })])

    const moveResponse = await fetch(`${secondUrl}/${created.id}`, {
      body: JSON.stringify({ scope: 'workspace' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PATCH',
    })
    await expect(moveResponse.json()).resolves.toEqual(
      expect.objectContaining({ scope: 'workspace', workspace_id: second.id })
    )

    await expect(
      (await fetch(`${firstUrl}?scope=workspace`, { headers: { cookie } })).json()
    ).resolves.toEqual([])
  })
})
