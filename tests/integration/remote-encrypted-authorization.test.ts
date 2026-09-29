import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { WebSocketServer } from 'ws'
import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import { InMemoryDeviceSessionProvider } from '../../src/server/remote-device-session.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  decodeHttpData,
  decodeWsMessage,
  encodeHttpBodyChunk,
  encodeOpenPayload,
  encodeWsMessage,
  FrameKind,
  StreamTransport,
} from '../../src/shared/remote-protocol.js'
import { createEncryptedRemoteClient } from '../helpers/encrypted-remote-client.js'
import { startTestServer } from '../helpers/test-server.js'

const waitFor = async (assertion: () => void) => {
  let failure: unknown
  for (let i = 0; i < 250; i += 1) {
    try {
      assertion()
      return
    } catch (error) {
      failure = error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw failure
}
const deviceInput = () => ({
  id: randomUUID(),
  name: 'Encrypted phone',
  keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
  devicePublicKey: new Uint8Array(32).fill(3),
})

test('encrypted requests cross the real bridge and runtime with scoped grants and actual response audit', async () => {
  const server = await startTestServer()
  const input = deviceInput()
  const device = server.store.remote.devices.insert(input)
  const workspace = server.store.createWorkspace(join(server.dataDir, 'visible'), 'Visible')
  server.store.createWorkspace(join(server.dataDir, 'hidden'), 'Hidden')
  server.store.remote.permissions.setReadScopes(device.id, [workspace.id])
  const sessions = new InMemoryDeviceSessionProvider()
  sessions.set({ deviceId: device.id, keys: input.keys, devicePublicKey: input.devicePublicKey })
  const phone = createEncryptedRemoteClient(
    {
      loopbackPort: Number(new URL(server.baseUrl).port),
      loopbackSecret: server.store.getRemoteTunnelSecret(),
      deviceSessions: sessions,
      audit: server.store.remote.audit,
      daemonId: 'fixture',
      inputEpoch: server.store.remote.permissions.inputEpoch,
    },
    device.id
  )
  let streamId = 1
  const request = async (method: string, path: string, body?: unknown) => {
    const id = streamId++
    phone.send(
      id,
      FrameKind.Open,
      encodeOpenPayload({
        transport: StreamTransport.Http,
        http: {
          method,
          path,
          headers: [
            ['content-type', 'application/json'],
            ['cookie', `hive_ui_token=${server.store.getUiToken()}`],
            ['x-hive-remote-device', 'spoofed'],
          ],
          hasBody: body !== undefined,
        },
      })
    )
    if (body !== undefined)
      phone.send(id, FrameKind.Data, encodeHttpBodyChunk(Buffer.from(JSON.stringify(body))))
    phone.send(id, FrameKind.End)
    await waitFor(() =>
      expect(
        phone
          .read()
          .some((frame) => frame.header.streamId === id && frame.header.kind === FrameKind.End)
      ).toBe(true)
    )
    const data = phone
      .read()
      .filter((frame) => frame.header.streamId === id && frame.header.kind === FrameKind.Data)
      .map((frame) => decodeHttpData(frame.payload))
    const head = data.find((item) => item.kind === 'head')
    if (!head || head.kind !== 'head') throw new Error('Missing HTTP response head')
    return {
      status: head.head.status,
      body: Buffer.concat(
        data.flatMap((item) => (item.kind === 'body' ? [item.data] : []))
      ).toString(),
    }
  }
  try {
    const visible = await request('GET', '/api/workspaces')
    expect(visible.status).toBe(200)
    expect(JSON.parse(visible.body).map((item: { id: string }) => item.id)).toEqual([workspace.id])
    const path = `/api/workspaces/${workspace.id}/tasks`
    expect((await request('PUT', path, { content: 'blocked' })).status).toBe(403)
    const pending = server.store.remote.permissions.request(device.id, {
      workspaceId: workspace.id,
      actions: ['task_write'],
    })
    const grant = server.store.remote.permissions.approve(pending.id)
    const secret = `synthetic-body-${randomUUID()}`
    const tasks = JSON.parse((await request('GET', path)).body)
    expect(
      (await request('PUT', path, { content: secret, expected_version: tasks.version })).status
    ).toBe(200)
    expect((await request('GET', path)).body).toContain(secret)
    server.store.remote.permissions.revokeGrant(grant.id)
    expect((await request('PUT', path, { content: 'blocked again' })).status).toBe(403)
    const audit = server.store.remote.audit.list(1000)
    expect(JSON.stringify(audit)).not.toContain(secret)
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'http_transport',
          status_code: 403,
          result: 'rejected',
          device_id: device.id,
        }),
        expect.objectContaining({
          action: 'http',
          business_action: 'task_write',
          status_code: 200,
          grant_id: grant.id,
        }),
      ])
    )
  } finally {
    phone.close()
    await server.close()
  }
})

test('queued encrypted input is discarded when a grant changes before loopback WebSocket connection', async () => {
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  const received: string[] = []
  const acknowledgements: string[] = []
  server.on('upgrade', (request, socket, head) => {
    setTimeout(
      () =>
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.on('message', (data) => {
            if (request.url?.includes('/control')) acknowledgements.push(data.toString())
            else received.push(data.toString())
          })
        }),
      350
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  const input = deviceInput()
  const sessions = new InMemoryDeviceSessionProvider()
  sessions.set({ deviceId: input.id, keys: input.keys, devicePublicKey: input.devicePublicKey })
  let epoch = 'original-grant'
  const phone = createEncryptedRemoteClient(
    {
      loopbackPort: address.port,
      loopbackSecret: 'fixture',
      deviceSessions: sessions,
      audit: createRemoteAuditStore(db),
      daemonId: 'queue-fixture',
      inputEpoch: () => epoch,
    },
    input.id
  )
  try {
    phone.send(
      1,
      FrameKind.Open,
      encodeOpenPayload({
        transport: StreamTransport.Ws,
        ws: { path: '/ws/terminal/run/io', query: [['clientId', 'same']] },
      })
    )
    phone.send(1, FrameKind.Data, encodeWsMessage(Buffer.from('stale-secret'), true))
    epoch = 'replacement-grant'
    await waitFor(() =>
      expect(
        phone
          .read()
          .filter((frame) => frame.header.kind === FrameKind.Data)
          .map((frame) => Buffer.from(decodeWsMessage(frame.payload).data).toString())
          .join('')
      ).toContain('Queued input discarded')
    )
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(received).toEqual([])
    expect(acknowledgements.map((item) => JSON.parse(item).type)).toContain('output_ack')
    phone.send(1, FrameKind.Data, encodeWsMessage(Buffer.from('newly-authorized'), true))
    await waitFor(() => expect(received).toEqual(['newly-authorized']))
  } finally {
    phone.close()
    for (const client of wss.clients) client.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    wss.close()
    db.close()
  }
})
