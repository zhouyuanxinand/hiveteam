import type { Socket } from 'node:net'

import type WebSocket from 'ws'

export const FLOW_CONTROL = {
  BATCH_INTERVAL_MS: 4,
  LOW_LATENCY_THRESHOLD_BYTES: 256,
  WS_BUFFERED_HIGH_WATER: 16 * 1024,
  WS_BUFFERED_LOW_WATER: 8 * 1024,
  UNACKED_HIGH_WATER: 100 * 1024,
  UNACKED_LOW_WATER: 50 * 1024,
  VIEWER_MAX_BYTES: 512 * 1024,
  ACK_TIMEOUT_MS: 5000,
} as const

const LOW_LATENCY_IDLE_WINDOW_MS = 5
const RESUME_CHECK_INTERVAL_MS = 16

interface TerminalOutputFlowOptions {
  onBackpressureChange: (backpressured: boolean) => void
  onOverflow?: (reason: string) => void
}

export interface TerminalOutputFlow {
  metrics: () => {
    queued_bytes: number
    unacked_bytes: number
    transport_bytes: number
    backpressured: boolean
  }
  ack: (bytes: number) => void
  close: () => void
  enqueue: (chunk: string) => void
}

const getTransportSocket = (ws: WebSocket): Socket | null => {
  return ((ws as WebSocket & { _socket?: Socket })._socket ?? null) as Socket | null
}

const byteLength = (chunk: string) => Buffer.byteLength(chunk, 'utf8')

export const createTerminalOutputFlow = (
  ws: WebSocket,
  { onBackpressureChange, onOverflow }: TerminalOutputFlowOptions
): TerminalOutputFlow => {
  let closed = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let lastSentAt = 0
  let pendingChunks: string[] = []
  let resumeCheckTimer: ReturnType<typeof setTimeout> | null = null
  let paused = false
  let unackedBytes = 0
  let pendingBytes = 0
  let ackTimer: ReturnType<typeof setTimeout> | null = null
  const clearAckTimer = () => {
    if (ackTimer) clearTimeout(ackTimer)
    ackTimer = null
  }
  const close = () => {
    closed = true
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    clearAckTimer()
    clearResumeCheck()
    pendingChunks = []
    pendingBytes = 0
    if (paused) {
      paused = false
      onBackpressureChange(false)
    }
  }
  const overflow = (reason: string) => {
    close()
    if (onOverflow) onOverflow(reason)
    else ws.close(4008, reason)
  }
  const scheduleAckDeadline = () => {
    if (ackTimer || !unackedBytes || closed) return
    ackTimer = setTimeout(
      () => overflow('Terminal viewer acknowledgement timed out'),
      FLOW_CONTROL.ACK_TIMEOUT_MS
    )
    ackTimer.unref()
  }

  const shouldPause = () => {
    return (
      ws.bufferedAmount >= FLOW_CONTROL.WS_BUFFERED_HIGH_WATER ||
      unackedBytes >= FLOW_CONTROL.UNACKED_HIGH_WATER
    )
  }

  const canResume = () => {
    return (
      ws.bufferedAmount < FLOW_CONTROL.WS_BUFFERED_LOW_WATER &&
      unackedBytes < FLOW_CONTROL.UNACKED_LOW_WATER
    )
  }

  const clearResumeCheck = () => {
    if (resumeCheckTimer) clearTimeout(resumeCheckTimer)
    resumeCheckTimer = null
    getTransportSocket(ws)?.removeListener('drain', checkResume)
  }

  const scheduleResumeCheck = () => {
    if (!paused || closed) return
    clearResumeCheck()
    getTransportSocket(ws)?.once('drain', checkResume)
    resumeCheckTimer = setTimeout(checkResume, RESUME_CHECK_INTERVAL_MS)
  }

  const checkResume = () => {
    if (!paused || closed) {
      clearResumeCheck()
      return
    }
    if (canResume()) {
      paused = false
      clearResumeCheck()
      onBackpressureChange(false)
      flush()
      return
    }
    scheduleResumeCheck()
  }

  const afterSend = (bytes: number) => {
    if (closed) return
    unackedBytes += bytes
    scheduleAckDeadline()
    if (shouldPause()) {
      paused = true
      onBackpressureChange(true)
      scheduleResumeCheck()
    }
  }

  const sendChunk = (chunk: string) => {
    if (closed || ws.readyState !== ws.OPEN) return
    ws.send(chunk)
    lastSentAt = Date.now()
    afterSend(byteLength(chunk))
  }

  const flush = () => {
    flushTimer = null
    if (closed || paused || pendingChunks.length === 0) return
    const chunk = pendingChunks.join('')
    pendingChunks = []
    pendingBytes = 0
    sendChunk(chunk)
  }

  return {
    metrics: () => ({
      queued_bytes: pendingBytes,
      unacked_bytes: unackedBytes,
      transport_bytes: ws.bufferedAmount,
      backpressured: paused,
    }),
    ack(bytes) {
      if (closed || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > unackedBytes) return
      unackedBytes = Math.max(0, unackedBytes - Math.max(0, Math.floor(bytes)))
      clearAckTimer()
      scheduleAckDeadline()
      checkResume()
    },
    close,
    enqueue(chunk) {
      if (closed) return
      const size = byteLength(chunk)
      if (size + pendingBytes + unackedBytes + ws.bufferedAmount > FLOW_CONTROL.VIEWER_MAX_BYTES) {
        overflow('Terminal viewer buffer limit exceeded')
        return
      }
      const now = Date.now()
      const isLowLatency =
        !paused &&
        pendingChunks.length === 0 &&
        flushTimer === null &&
        byteLength(chunk) < FLOW_CONTROL.LOW_LATENCY_THRESHOLD_BYTES &&
        now - lastSentAt >= LOW_LATENCY_IDLE_WINDOW_MS
      if (isLowLatency) {
        sendChunk(chunk)
        return
      }
      pendingChunks.push(chunk)
      pendingBytes += size
      if (!paused && !flushTimer) flushTimer = setTimeout(flush, FLOW_CONTROL.BATCH_INTERVAL_MS)
    },
  }
}
