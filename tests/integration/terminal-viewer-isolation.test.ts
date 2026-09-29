import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import { FLOW_CONTROL } from '../../src/server/terminal-flow-control.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const fixture = async (script: string) => {
  const server = await startAuthorizedTestServer()
  cleanup.push(server.close)
  const workspace = server.store.createWorkspace(server.dataDir, 'Terminal fixture')
  const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: ['-e', script],
  })
  const run = await server.store.startAgent(workspace.id, worker.id, {
    hivePort: new URL(server.baseUrl).port,
  })
  const cookie = await getUiCookie(server.baseUrl)
  const viewer = async (ack: boolean, id = randomUUID(), coordinated = false) => {
    const base = `${server.baseUrl.replace('http:', 'ws:')}/ws/terminal/${run.runId}`
    const query = `clientId=${id}${coordinated ? '&snapshot=1' : ''}`
    const io = new WebSocket(`${base}/io?${query}`, { headers: { cookie } })
    const control = new WebSocket(`${base}/control?${query}`, { headers: { cookie } })
    cleanup.push(() => {
      io.terminate()
      control.terminate()
    })
    const received = { bytes: 0, text: '', snapshot: '', errors: [] as string[], closed: false }
    io.on('close', () => {
      received.closed = true
    })
    io.on('message', (raw) => {
      const chunk = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw)
      received.bytes += chunk.length
      received.text += chunk.toString()
      if (ack && control.readyState === 1)
        control.send(
          JSON.stringify({ type: 'output_ack', bytes: Buffer.byteLength(chunk.toString()) })
        )
    })
    control.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.type === 'restore') received.snapshot = m.snapshot
      if (m.type === 'error') received.errors.push(m.message)
    })
    await Promise.all([once(io, 'open'), once(control, 'open')])
    return { io, control, received, id }
  }
  return { ...server, run, viewer }
}

test('a real slow WS viewer is disconnected within its budget while the healthy viewer and PTY progress', async () => {
  const f = await fixture(
    'let n=0;process.stdin.on("data",()=>{setInterval(()=>process.stdout.write(`tick:${n++} 输出中文\\r\\n`+"x".repeat(8000)+"\\r\\n"),10)});'
  )
  const healthy = await f.viewer(true),
    slow = await f.viewer(false)
  f.store.writeRunInput(f.run.runId, 'begin\r')
  let peak = 0
  await vi.waitFor(
    () => {
      for (const run of f.terminalMetrics())
        for (const viewer of run.viewers)
          peak = Math.max(peak, viewer.queued_bytes + viewer.unacked_bytes + viewer.transport_bytes)
      expect(slow.received.closed).toBe(true)
    },
    { timeout: 8000, interval: 20 }
  )
  expect(peak).toBeLessThanOrEqual(FLOW_CONTROL.VIEWER_MAX_BYTES)
  expect(slow.received.errors.join(' ')).toContain('history may be missing')
  const before = healthy.received.bytes
  await vi.waitFor(() => expect(healthy.received.bytes).toBeGreaterThan(before + 40000))
  expect(healthy.received.closed).toBe(false)
  expect(healthy.received.text).toContain('输出中文')
  const resumed = await f.viewer(true, randomUUID(), true)
  await vi.waitFor(() => expect(resumed.received.snapshot).toContain('tick:'))
  await vi.waitFor(() => expect(resumed.received.bytes).toBeGreaterThan(1000))
}, 20000)

test('snapshot cut excludes later live output and replacing a client ID fences the old sockets', async () => {
  const f = await fixture(
    'let n=0;setInterval(()=>process.stdout.write(`序号:${n++}\\r\\n`),15);process.stdin.on("data",s=>process.stdout.write("输入:"+s));'
  )
  const first = await f.viewer(true, randomUUID(), true)
  await vi.waitFor(() => expect(first.received.text).toContain('序号:'), { timeout: 10_000 })
  const second = await f.viewer(true, first.id, true)
  await vi.waitFor(() => expect(first.received.closed).toBe(true))
  await vi.waitFor(() =>
    expect(second.received.text.match(/序号:(\d+)/gu)?.length ?? 0).toBeGreaterThan(5)
  )
  const historical = [...second.received.snapshot.matchAll(/序号:(\d+)/gu)].map((m) => Number(m[1]))
  const live = [...second.received.text.matchAll(/序号:(\d+)/gu)].map((m) => Number(m[1]))
  expect(historical.length).toBeGreaterThan(0)
  expect(live[0]).toBe(Math.max(...historical) + 1)
  expect(new Set([...historical, ...live]).size).toBe(historical.length + live.length)
  second.io.send('中文重连\r')
  await vi.waitFor(() => expect(second.received.text).toContain('输入:中文重连'))
}, 15000)
