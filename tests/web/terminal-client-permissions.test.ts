// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { createTerminalClient } from '../../web/src/terminal/terminal-client.js'

class Socket {
  static all: Socket[] = []
  OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  sent: Array<string | Uint8Array> = []
  constructor(readonly url: string) {
    Socket.all.push(this)
  }
  send(data: string | Uint8Array) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  receive(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

afterEach(() => {
  Socket.all = []
  delete (window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('remote terminal keeps output and ACKs while input is denied, granted, then expires', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Socket)
  ;(window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__ = true
  const output: string[] = []
  const permissions: boolean[] = []
  const errors: string[] = []
  const client = createTerminalClient({
    runId: 'remote-run',
    initialSize: { cols: 180, rows: 70 },
    onError: (message) => errors.push(message),
    onExit: () => {},
    onOutput: (chunk, acknowledge) => {
      output.push(chunk)
      acknowledge(chunk.length)
    },
    onRestore: () => {},
    onInputPermissionChange: (allowed) => permissions.push(allowed),
  })
  const [io, control] = Socket.all
  if (!io || !control) throw new Error('Missing terminal sockets')
  try {
    control.receive({ type: 'restore', snapshot: 'history' })
    await Promise.resolve()
    await Promise.resolve()
    client.sendInput('secret text')
    client.sendBinaryInput('secret binary')
    client.resize(180, 70)
    expect(io.sent).toEqual([])
    expect(control.sent).toEqual([JSON.stringify({ type: 'restore_complete' })])
    expect(permissions.at(-1)).toBe(false)
    await expect(client.retrySession()).rejects.toThrow('requires local approval')
    io.onmessage?.({ data: 'before grant' })
    expect(output).toEqual(['before grant'])
    expect(control.sent.at(-1)).toBe(JSON.stringify({ type: 'output_ack', bytes: 12 }))
    control.receive({
      type: 'permissions',
      workspace_id: 'workspace',
      actions: ['terminal_input'],
      remaining_ms: 1000,
    })
    expect(permissions.at(-1)).toBe(true)
    client.sendInput('allowed')
    client.sendBinaryInput('x')
    expect(io.sent).toEqual(['allowed', new Uint8Array([120])])
    expect(
      control.sent.some(
        (message) => typeof message === 'string' && JSON.parse(message).type === 'resize'
      )
    ).toBe(false)
    await vi.advanceTimersByTimeAsync(1001)
    client.sendInput('after expiry')
    expect(io.sent).toHaveLength(2)
    expect(permissions.at(-1)).toBe(false)
    io.onmessage?.({ data: 'after grant' })
    expect(output).toEqual(['before grant', 'after grant'])
    expect(control.sent.at(-1)).toBe(JSON.stringify({ type: 'output_ack', bytes: 11 }))
    expect(errors).toHaveLength(3)
  } finally {
    client.dispose()
  }
})

test('revocation and control disconnect discard a remote grant on an already connected IO channel', () => {
  vi.stubGlobal('WebSocket', Socket)
  ;(window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__ = true
  const client = createTerminalClient({
    runId: 'remote-run',
    onError: () => {},
    onExit: () => {},
    onOutput: () => {},
    onRestore: () => {},
  })
  const [io, control] = Socket.all
  if (!io || !control) throw new Error('Missing terminal sockets')
  try {
    control.receive({
      type: 'permissions',
      workspace_id: 'workspace',
      actions: ['terminal_input', 'terminal_resize'],
      remaining_ms: 60_000,
    })
    client.resize(80, 24)
    client.sendInput('first')
    expect(control.sent).toEqual([JSON.stringify({ type: 'resize', cols: 80, rows: 24 })])
    control.receive({
      type: 'permissions',
      workspace_id: 'workspace',
      actions: [],
      remaining_ms: 0,
    })
    client.sendInput('revoked')
    control.receive({
      type: 'permissions',
      workspace_id: 'workspace',
      actions: ['terminal_input'],
      remaining_ms: 60_000,
    })
    control.close()
    client.sendBinaryInput('disconnected')
    expect(io.sent).toEqual(['first'])
  } finally {
    client.dispose()
  }
})
