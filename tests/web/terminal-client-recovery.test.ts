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
  sent: string[] = []
  constructor(readonly url: string) {
    Socket.all.push(this)
  }
  send(data: string) {
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const setup = async () => {
  vi.stubGlobal('WebSocket', Socket)
  const connectionStates: string[] = []
  const client = createTerminalClient({
    runId: 'original-run',
    onError: () => {},
    onExit: () => {},
    onOutput: () => {},
    onRestore: () => {},
    onConnectionChange: (state) => connectionStates.push(state),
  })
  const control = Socket.all[1]
  if (!control) throw new Error('Control connection missing')
  control.receive({ type: 'restore', snapshot: 'history' })
  await Promise.resolve()
  await Promise.resolve()
  return { client, control, connectionStates }
}

test('times out an unanswered recovery request and allows a new attempt', async () => {
  vi.useFakeTimers()
  const { client, control } = await setup()
  try {
    const result = client.retrySession()
    const rejected = expect(result).rejects.toThrow('No retry response received')
    await vi.advanceTimersByTimeAsync(8000)
    await rejected
    const next = client.retrySession()
    const request = JSON.parse(control.sent.at(-1) ?? '{}')
    control.receive({
      type: 'session_retry',
      request_id: request.request_id,
      status: 'still_locked',
    })
    expect(await next).toBe('still_locked')
  } finally {
    client.dispose()
  }
})

test('a disconnect rejects an in-flight retry instead of leaving the button pending', async () => {
  const { client, control, connectionStates } = await setup()
  try {
    const result = client.retrySession()
    const rejected = expect(result).rejects.toThrow('Terminal connection closed')
    control.close()
    await rejected
    expect(connectionStates.at(-1)).toBe('disconnected')
    await expect(client.retrySession()).rejects.toThrow('Terminal is not connected')
  } finally {
    client.dispose()
  }
})

test('ignores an unrelated response and prevents concurrent requests on one client', async () => {
  const { client, control } = await setup()
  try {
    const result = client.retrySession()
    const request = JSON.parse(control.sent.at(-1) ?? '{}')
    control.receive({
      type: 'session_retry',
      request_id: 'another-request',
      status: 'prompt_cleared',
    })
    expect(await client.retrySession()).toBe('retry_pending')
    control.receive({
      type: 'session_retry',
      request_id: request.request_id,
      status: 'still_locked',
    })
    expect(await result).toBe('still_locked')
    expect(
      control.sent
        .map((value) => JSON.parse(value))
        .filter((value) => value.type === 'retry_session')
    ).toHaveLength(1)
  } finally {
    client.dispose()
  }
})
