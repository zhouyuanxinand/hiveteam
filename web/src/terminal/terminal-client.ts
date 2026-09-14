import type {
  TerminalSessionRecovery,
  TerminalSessionRetryStatus,
} from '../../../src/shared/terminal-recovery.js'

type TerminalControlServerMessage =
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null }
  | { type: 'restore'; snapshot: string }
  | { type: 'session_recovery'; recovery: TerminalSessionRecovery | null }
  | { type: 'session_retry'; request_id: string; status: TerminalSessionRetryStatus }

export type TerminalConnectionStatus = 'connecting' | 'connected' | 'disconnected'

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
  onRecovery?: (recovery: TerminalSessionRecovery | null) => void
  onConnectionChange?: (status: TerminalConnectionStatus) => void
  runId: string
}

export interface TerminalClient {
  dispose: () => void
  resize: (cols: number, rows: number, pixelWidth?: number, pixelHeight?: number) => void
  sendBinaryInput: (chunk: string) => void
  sendInput: (chunk: string) => void
  retrySession: () => Promise<TerminalSessionRetryStatus>
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
  onRecovery,
  onConnectionChange,
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
  let exited = false
  let pendingRetry:
    | {
        requestId: string
        resolve: (status: TerminalSessionRetryStatus) => void
        reject: (error: Error) => void
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  const rejectRetry = (message: string) => {
    if (!pendingRetry) return
    clearTimeout(pendingRetry.timer)
    pendingRetry.reject(new Error(message))
    pendingRetry = undefined
  }
  const updateConnection = () => {
    if (disposed || exited) return
    const disconnected = ioSocket.readyState >= 2 || controlSocket.readyState >= 2
    onConnectionChange?.(
      disconnected
        ? 'disconnected'
        : restored &&
            ioSocket.readyState === ioSocket.OPEN &&
            controlSocket.readyState === controlSocket.OPEN
          ? 'connected'
          : 'connecting'
    )
    if (disconnected) rejectRetry('Terminal connection closed. Reconnect and retry.')
  }
  const connectionFailed = () => {
    if (disposed || exited) return
    onConnectionChange?.('disconnected')
    rejectRetry('Terminal connection failed. Reconnect and retry.')
  }
  ioSocket.onopen = updateConnection
  ioSocket.onclose = updateConnection
  controlSocket.onclose = updateConnection
  ioSocket.onerror = connectionFailed
  controlSocket.onerror = connectionFailed
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
    updateConnection()
  }
  const completeRestore = () => {
    if (disposed) return
    restored = true
    restoring = false
    updateConnection()
    if (controlSocket.readyState === controlSocket.OPEN) {
      controlSocket.send(JSON.stringify({ type: 'restore_complete' }))
    }
    for (const output of pendingOutput.splice(0)) {
      onOutput(output.chunk, output.acknowledge)
    }
  }

  controlSocket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as TerminalControlServerMessage
    if (message.type === 'exit') {
      exited = true
      rejectRetry('The terminal has stopped.')
      onRecovery?.(null)
      onExit(message.code)
    }
    if (message.type === 'error') {
      rejectRetry(message.message)
      onError(message.message)
      if (!restored) onConnectionChange?.('disconnected')
    }
    if (message.type === 'session_recovery' && !exited) onRecovery?.(message.recovery)
    if (message.type === 'session_retry' && pendingRetry?.requestId === message.request_id) {
      clearTimeout(pendingRetry.timer)
      pendingRetry.resolve(message.status)
      pendingRetry = undefined
    }
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
      rejectRetry('Terminal disconnected.')
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
    retrySession() {
      if (pendingRetry) return Promise.resolve('retry_pending')
      if (
        disposed ||
        exited ||
        !restored ||
        ioSocket.readyState !== ioSocket.OPEN ||
        controlSocket.readyState !== controlSocket.OPEN
      ) {
        return Promise.reject(new Error('Terminal is not connected. Reconnect and retry.'))
      }
      return new Promise<TerminalSessionRetryStatus>((resolve, reject) => {
        const requestId = crypto.randomUUID()
        const timer = setTimeout(
          () =>
            rejectRetry(
              'No retry response received. Reconnect the terminal to check its current state.'
            ),
          8000
        )
        pendingRetry = { requestId, resolve, reject, timer }
        controlSocket.send(JSON.stringify({ type: 'retry_session', request_id: requestId }))
      })
    },
  }
}
