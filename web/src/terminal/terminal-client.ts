type TerminalControlServerMessage =
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null }
  | { type: 'restore'; snapshot: string }

interface TerminalClientOptions {
  initialSize?: {
    cols: number
    pixelHeight?: number
    pixelWidth?: number
    rows: number
  }
  onError: (message: string) => void
  onExit: (code: number | null) => void
  onOutput: (chunk: string, acknowledge: (bytes: number) => void) => void
  /**
   * Rehydrate the terminal before live PTY output is replayed. Returning a
   * promise lets the renderer wait for xterm's asynchronous write queue.
   */
  onRestore: (snapshot: string) => void | Promise<void>
  runId: string
}

export interface TerminalClient {
  dispose: () => void
  resize: (cols: number, rows: number, pixelWidth?: number, pixelHeight?: number) => void
  sendBinaryInput: (chunk: string) => void
  sendInput: (chunk: string) => void
}

const toWebSocketUrl = (path: string, params: Record<string, number | string | undefined> = {}) => {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

export const createTerminalClient = ({
  initialSize,
  onError,
  onExit,
  onOutput,
  onRestore,
  runId,
}: TerminalClientOptions): TerminalClient => {
  const clientId = crypto.randomUUID()
  const connectionParams = { ...initialSize, clientId }
  const ioSocket = new WebSocket(toWebSocketUrl(`/ws/terminal/${runId}/io`, connectionParams))
  const controlSocket = new WebSocket(
    toWebSocketUrl(`/ws/terminal/${runId}/control`, connectionParams)
  )
  let disposed = false
  let restored = false
  let restoring = false
  const pendingOutput: Array<{ chunk: string; acknowledge: (bytes: number) => void }> = []
  let pendingResize: {
    cols: number
    rows: number
    pixelWidth?: number
    pixelHeight?: number
  } | null = null

  const sendResize = () => {
    if (!pendingResize || controlSocket.readyState !== controlSocket.OPEN) return
    controlSocket.send(JSON.stringify({ type: 'resize', ...pendingResize }))
    pendingResize = null
  }

  ioSocket.onmessage = (event) => {
    const chunk = typeof event.data === 'string' ? event.data : ''
    const acknowledge = (bytes: number) => {
      if (controlSocket.readyState !== controlSocket.OPEN) return
      controlSocket.send(JSON.stringify({ type: 'output_ack', bytes }))
    }
    if (!restored) {
      pendingOutput.push({ chunk, acknowledge })
      return
    }
    onOutput(chunk, acknowledge)
  }
  controlSocket.onopen = () => {
    sendResize()
  }
  const completeRestore = () => {
    if (disposed) return
    restored = true
    restoring = false
    if (controlSocket.readyState === controlSocket.OPEN) {
      controlSocket.send(JSON.stringify({ type: 'restore_complete' }))
    }
    for (const output of pendingOutput.splice(0)) {
      onOutput(output.chunk, output.acknowledge)
    }
  }

  controlSocket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as TerminalControlServerMessage
    if (message.type === 'exit') onExit(message.code)
    if (message.type === 'error') onError(message.message)
    if (message.type === 'restore') {
      if (restored || restoring) return
      restoring = true
      let restoreResult: void | Promise<void>
      try {
        // Start xterm's write immediately so a following IO frame can be
        // buffered behind the exact snapshot it belongs to.
        restoreResult = onRestore(message.snapshot)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        onError(`Failed to restore terminal: ${detail}`)
        restoreResult = undefined
      }
      void Promise.resolve(restoreResult)
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error)
          onError(`Failed to restore terminal: ${detail}`)
        })
        .then(completeRestore)
    }
  }

  return {
    dispose() {
      disposed = true
      ioSocket.close()
      controlSocket.close()
    },
    resize(cols, rows, pixelWidth, pixelHeight) {
      pendingResize = { cols, rows }
      if (pixelWidth !== undefined) pendingResize.pixelWidth = pixelWidth
      if (pixelHeight !== undefined) pendingResize.pixelHeight = pixelHeight
      sendResize()
    },
    sendBinaryInput(chunk) {
      if (ioSocket.readyState !== ioSocket.OPEN) return
      const bytes = new Uint8Array(chunk.length)
      for (let index = 0; index < chunk.length; index++) {
        bytes[index] = chunk.charCodeAt(index) & 0xff
      }
      ioSocket.send(bytes)
    },
    sendInput(chunk) {
      if (ioSocket.readyState !== ioSocket.OPEN) return
      ioSocket.send(chunk)
    },
  }
}
