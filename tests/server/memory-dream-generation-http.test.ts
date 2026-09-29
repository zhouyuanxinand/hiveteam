import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { createMessageLogStore } from '../../src/server/message-log-store.js'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import type { RemoteAction } from '../../src/shared/remote-permissions.js'
import { createAttentionFixture } from '../helpers/attention-fixture.js'

test('generate and discard reject null, arrays and scalar JSON without changing stored drafts or cursors', async () => {
  const f = await createAttentionFixture()
  try {
    const run = f.server.store.memoryDream.create(f.workspace.id)
    const base = `/api/ui/workspaces/${f.workspace.id}/memory/dream`
    for (const suffix of ['/generate', `/${run.id}/discard`]) {
      for (const body of [null, [], 42, 'invalid']) {
        const response = await fetch(`${f.server.baseUrl}${base}${suffix}`, {
          method: 'POST',
          headers: { cookie: f.cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ error: 'Dream request must be an object' })
      }
    }
    expect(f.server.store.memoryDream.get(f.workspace.id, run.id)).toEqual(run)
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM memory_dream_generations').get()).toEqual({
      count: 0,
    })
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM memory_dream_cursors').get()).toEqual({
      count: 0,
    })
  } finally {
    await f.close()
  }
})

test('remote generation requires both grants, discard only memory_write, and agent result endpoints remain desktop-only', async () => {
  const f = await createAttentionFixture()
  try {
    const device = f.server.store.remote.devices.insert({
      id: randomUUID(),
      name: 'Dream review phone',
      keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
      devicePublicKey: new Uint8Array(32).fill(3),
    })
    const permissions = f.server.store.remote.permissions
    permissions.setReadScopes(device.id, [f.workspace.id])
    const headers = stampLoopbackHeaders(
      { 'content-type': 'application/json' },
      f.server.store.getRemoteTunnelSecret(),
      device.id
    )
    const call = (path: string, body: unknown) =>
      fetch(`${f.server.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    const grant = (actions: RemoteAction[]) =>
      permissions.approve(
        permissions.request(device.id, { workspaceId: f.workspace.id, actions }).id
      )
    const base = `/api/ui/workspaces/${f.workspace.id}/memory/dream`
    const draft = f.server.store.memoryDream.create(f.workspace.id)
    const discard = () =>
      call(`${base}/${draft.id}/discard`, { expected_revision: draft.planRevision })
    expect((await discard()).status).toBe(403)
    expect(f.server.store.memoryDream.get(f.workspace.id, draft.id)?.status).toBe('review')
    const memory = grant(['memory_write'])
    expect((await discard()).status).toBe(200)
    expect(f.server.store.memoryDream.get(f.workspace.id, draft.id)?.status).toBe('discarded')
    const messages = createMessageLogStore(f.db)
    messages.insertMessage({
      workspaceId: f.workspace.id,
      workerId: f.actor,
      type: 'user_input',
      text: 'Use signed release artifacts.',
      createdAt: Date.now(),
    })
    expect((await call(`${base}/generate`, {})).status).toBe(403)
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM memory_dream_generations').get()).toEqual({
      count: 0,
    })
    permissions.revokeGrant(memory.id)
    const agent = grant(['agent_start'])
    expect((await call(`${base}/generate`, {})).status).toBe(403)
    permissions.revokeGrant(agent.id)
    grant(['agent_start', 'memory_write'])
    const generated = await call(`${base}/generate`, {})
    expect(generated.status).toBe(201)
    const run = await generated.json()
    expect(run.generation).toMatchObject({ status: 'pending' })
    for (const action of ['input', 'result', 'fail']) {
      const response = await call(`/api/team/dream/${action}`, {
        project_id: f.workspace.id,
        from_agent_id: f.actor,
        token: f.server.store.peekAgentToken(f.actor),
        dream_id: run.id,
        attempt_id: 'synthetic-attempt',
        input_hash: run.generation.input_hash,
        result: { candidates: [], summary: 'Do not publish through remote agent endpoints' },
        error: 'Do not mutate',
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'remote_endpoint_forbidden' })
    }
    expect(f.server.store.memoryDream.get(f.workspace.id, run.id)?.generation?.status).toBe(
      'pending'
    )
    expect(f.server.store.memory.list(f.workspace.id)).toEqual([])
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM memory_dream_cursors').get()).toEqual({
      count: 0,
    })
  } finally {
    await f.close()
  }
})
