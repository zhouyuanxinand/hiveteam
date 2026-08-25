import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'

import { GW_CONTROL_PREFIX } from '../../gateway/src/protocol.js'
import { createGatewayServer } from '../../gateway/src/server.js'

const temporaryDirectories: string[] = []

const createTemporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-gateway-server-'))
  temporaryDirectories.push(directory)
  return directory
}

const readJson = async (response: Response) => (await response.json()) as Record<string, unknown>

const waitForMessage = (socket: WebSocket, predicate: (message: string) => boolean) =>
  new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('timed out waiting for WebSocket message'))
    }, 2_000)
    const onMessage = (data: WebSocket.RawData) => {
      const message = data.toString()
      if (!predicate(message)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
  })

const toBuffer = (data: WebSocket.RawData) =>
  Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(new Uint8Array(data))
      : Buffer.from(data)

const waitForBinary = (socket: WebSocket, expected: Buffer) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('timed out waiting for binary WebSocket message'))
    }, 2_000)
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary || !toBuffer(data).equals(expected)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve()
    }
    socket.on('message', onMessage)
  })

const waitForCloseCode = (socket: WebSocket) =>
  new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for WebSocket close')),
      2_000
    )
    socket.once('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    socket.once('error', reject)
  })

const openSocket = (url: string, options?: WebSocket.ClientOptions, protocols?: string[]) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, protocols ?? [], options)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('gateway relay server', () => {
  test('serves the mobile remote entry and bundled assets', async () => {
    const dataDir = createTemporaryDirectory()
    const webDistDir = createTemporaryDirectory()
    mkdirSync(join(webDistDir, 'assets'))
    writeFileSync(join(webDistDir, 'remote.html'), '<!doctype html><title>Hive Remote</title>')
    writeFileSync(join(webDistDir, 'assets', 'remote.js'), 'console.log("hive")')
    const gateway = createGatewayServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      ownerToken: 'owner-token-for-tests',
      webDistDir,
    })
    await gateway.start()

    try {
      const appResponse = await fetch(`http://${gateway.host}:${gateway.port}/app`)
      expect(appResponse.status).toBe(200)
      expect(appResponse.headers.get('content-type')).toContain('text/html')
      expect(await appResponse.text()).toContain('Hive Remote')

      const assetResponse = await fetch(`http://${gateway.host}:${gateway.port}/assets/remote.js`)
      expect(assetResponse.status).toBe(200)
      expect(assetResponse.headers.get('cache-control')).toContain('immutable')
      expect(await assetResponse.text()).toContain('console.log')

      const traversalResponse = await fetch(
        `http://${gateway.host}:${gateway.port}/assets/%2e%2e/remote.html`
      )
      expect(traversalResponse.status).toBe(404)
    } finally {
      await gateway.close()
    }
  })

  test('approves a daemon and relays pair traffic over WebSocket', async () => {
    const gateway = createGatewayServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: createTemporaryDirectory(),
      ownerToken: 'owner-token-for-tests',
    })
    await gateway.start()
    const baseUrl = `http://${gateway.host}:${gateway.port}`
    const wsBaseUrl = `ws://${gateway.host}:${gateway.port}`

    try {
      const issuedResponse = await fetch(`${baseUrl}/daemon/code`, { method: 'POST' })
      const issued = await readJson(issuedResponse)
      const code = String(issued.code)

      const pendingResponse = await fetch(`${baseUrl}/daemon/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      expect(pendingResponse.status).toBe(401)

      const approvalResponse = await fetch(`${baseUrl}/daemon/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, token: 'owner-token-for-tests' }),
      })
      expect(approvalResponse.status).toBe(200)

      const tokenResponse = await fetch(`${baseUrl}/daemon/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name: 'test machine' }),
      })
      const tokenPayload = await readJson(tokenResponse)
      expect(tokenResponse.status).toBe(200)
      const daemonId = String(tokenPayload.daemonId)
      const daemonToken = String(tokenPayload.daemonToken)

      const loginResponse = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'owner-token-for-tests' }),
      })
      expect(loginResponse.status).toBe(200)
      const cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0]
      expect(cookie).toBeTruthy()

      const daemonSocket = await openSocket(`${wsBaseUrl}/relay/daemon`, undefined, [
        `bearer.${daemonToken}`,
      ])
      const daemonOnline = waitForMessage(
        daemonSocket,
        (message) => message.includes('"t":"peer-online"') && message.includes('"role":"pair"')
      )
      const pairSocket = await openSocket(`${wsBaseUrl}/relay/pair?daemonId=${daemonId}`, {
        headers: { Cookie: cookie ?? '' },
      })
      const pairOnlineMessage = await daemonOnline
      const pairOnline = JSON.parse(pairOnlineMessage.slice(GW_CONTROL_PREFIX.length)) as {
        jti?: string
      }
      expect(pairOnline.jti).toEqual(expect.any(String))

      const pairHello = waitForMessage(pairSocket, (message) => message === 'hello')
      daemonSocket.send('hello')
      await pairHello

      const daemonAck = waitForMessage(daemonSocket, (message) => message === 'pair-ack')
      pairSocket.send('pair-ack')
      await daemonAck

      const confirmed = waitForMessage(pairSocket, (message) => message.includes('"t":"confirmed"'))
      const confirmResponse = await fetch(`${baseUrl}/pair/confirm`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${daemonToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          deviceId: 'phone-1',
          devicePubkey: 'public-key',
          name: 'Phone',
          boundJti: pairOnline.jti,
        }),
      })
      expect(confirmResponse.status).toBe(200)
      await confirmed

      const deviceOnline = waitForMessage(
        daemonSocket,
        (message) => message.includes('"t":"peer-online"') && message.includes('"role":"device"')
      )
      const deviceSocket = await openSocket(
        `${wsBaseUrl}/relay/device?daemonId=${daemonId}&deviceId=phone-1`,
        { headers: { Cookie: cookie ?? '' } }
      )
      await deviceOnline

      const daemonFrame = Buffer.from([1, 2, 3, 4])
      const deviceFrame = waitForBinary(deviceSocket, daemonFrame)
      daemonSocket.send(daemonFrame)
      await deviceFrame

      const deviceResponseFrame = Buffer.from([5, 6, 7])
      const daemonResponseFrame = waitForBinary(daemonSocket, deviceResponseFrame)
      deviceSocket.send(deviceResponseFrame)
      await daemonResponseFrame

      const deviceClosed = waitForCloseCode(deviceSocket)
      const revokeResponse = await fetch(`${baseUrl}/api/devices/phone-1/revoke`, {
        method: 'POST',
        headers: { Cookie: cookie ?? '' },
      })
      expect(revokeResponse.status).toBe(200)
      expect(await deviceClosed).toBe(4410)

      daemonSocket.close()
      pairSocket.close()
      deviceSocket.close()
    } finally {
      await gateway.close()
    }
  })
})
