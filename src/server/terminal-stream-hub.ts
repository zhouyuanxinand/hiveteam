import type WebSocket from 'ws'

import type { RuntimeStore } from './runtime-store.js'
import { createTerminalOutputFlow } from './terminal-flow-control.js'
import {
  parseTerminalControlMessage,
  serializeTerminalError,
  serializeTerminalExit,
  serializeTerminalRestore,
} from './terminal-protocol.js'
import { type TerminalMirrorSize, TerminalStateMirror } from './terminal-state-mirror.js'

interface ViewerState {
  clientId: string
  controlSocket: WebSocket | null
  flowState: ReturnType<typeof createTerminalOutputFlow> | null
  ioSocket: WebSocket | null
}

interface RunState {
  backpressuredViewerIds: Set<string>
  exited: boolean
  exitCode: number | null
  exitUnsubscribe: (() => void) | null
  mirror: TerminalStateMirror
  outputUnsubscribe: (() => void) | null
  viewers: Map<string, ViewerState>
}

const normalizeTerminalInput = (
  raw: ArrayBuffer | Buffer | Buffer[],
  isBinary: boolean
): Buffer | string => {
  const bytes = Buffer.isBuffer(raw)
    ? raw
    : Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.from(raw)
  return isBinary ? Buffer.from(bytes) : bytes.toString()
}

export interface TerminalStreamHub {
  attachControl: (
    runId: string,
    clientId: string,
    socket: WebSocket,
    initialSize?: TerminalMirrorSize
  ) => void
  attachIo: (
    runId: string,
    clientId: string,
    socket: WebSocket,
    initialSize?: TerminalMirrorSize
  ) => void
  close: () => void
}

export const createTerminalStreamHub = (store: RuntimeStore): TerminalStreamHub => {
  const runStates = new Map<string, RunState>()

  const maybeResumeRun = (runId: string, state: RunState, clientId: string) => {
    if (!state.backpressuredViewerIds.delete(clientId)) return
    if (state.backpressuredViewerIds.size === 0) store.resumeTerminalRun(runId)
  }

  const cleanupRun = (runId: string) => {
    const state = runStates.get(runId)
    if (!state?.exited || state.viewers.size > 0) return
    state.outputUnsubscribe?.()
    state.exitUnsubscribe?.()
    state.mirror.dispose()
    runStates.delete(runId)
  }

  const getOrCreateViewer = (state: RunState, clientId: string) => {
    let viewer = state.viewers.get(clientId)
    if (!viewer) {
      viewer = { clientId, controlSocket: null, flowState: null, ioSocket: null }
      state.viewers.set(clientId, viewer)
    }
    return viewer
  }

  const getOrCreateState = (runId: string, initialSize?: TerminalMirrorSize) => {
    let state = runStates.get(runId)
    if (!state) {
      state = {
        backpressuredViewerIds: new Set(),
        exited: false,
        exitCode: null,
        exitUnsubscribe: null,
        // runId is globally unique, so it is semantically equivalent to workspaceId:runId.
        mirror: new TerminalStateMirror(initialSize),
        outputUnsubscribe: null,
        viewers: new Map(),
      }
      runStates.set(runId, state)
      const liveRun = store.getLiveRun(runId)
      if (liveRun.output.length > 0) state.mirror.write(liveRun.output)
      const nextState = state
      nextState.outputUnsubscribe = store.getPtyOutputBus().subscribe(runId, (chunk) => {
        nextState.mirror.write(chunk)
        for (const viewer of nextState.viewers.values()) viewer.flowState?.enqueue(chunk)
      })
      nextState.exitUnsubscribe = store.getPtyOutputBus().subscribeExit(runId, () => {
        handleRunExit(runId)
      })
      // The run may have exited between the WebSocket upgrade check and this
      // subscription; publishExit fired before we started listening. Mark the
      // state in place — the attaching control socket reads it right after —
      // because handleRunExit's cleanup would dispose the mirror while this
      // state still has no viewers to hold it open.
      if (liveRun.status === 'exited' || liveRun.status === 'error') {
        nextState.exited = true
        nextState.exitCode = liveRun.exitCode
      }
    } else if (initialSize) {
      state.mirror.resize(initialSize.cols, initialSize.rows)
    }
    return state
  }

  const cleanupViewer = (runId: string, state: RunState, clientId: string) => {
    const viewer = state.viewers.get(clientId)
    if (!viewer || viewer.controlSocket || viewer.ioSocket) return
    state.viewers.delete(clientId)
    maybeResumeRun(runId, state, clientId)
    cleanupRun(runId)
  }

  const handleRunExit = (runId: string) => {
    const state = runStates.get(runId)
    if (!state || state.exited) return
    let exitCode: number | null = null
    try {
      const run = store.getLiveRun(runId)
      // The PTY exit path sets the terminal status before publishing, so a
      // still-running record means this runId was recycled or misreported.
      if (run.status !== 'exited' && run.status !== 'error') return
      exitCode = run.exitCode
    } catch {
      // The run record disappeared with the exit; still release viewers with a
      // code-less exit instead of leaving their terminals spinning.
    }
    state.exited = true
    state.exitCode = exitCode
    state.outputUnsubscribe?.()
    state.outputUnsubscribe = null
    state.exitUnsubscribe?.()
    state.exitUnsubscribe = null
    const payload = serializeTerminalExit(exitCode)
    for (const viewer of state.viewers.values()) {
      const controlSocket = viewer.controlSocket
      if (controlSocket && controlSocket.readyState === controlSocket.OPEN)
        controlSocket.send(payload)
    }
    cleanupRun(runId)
  }

  return {
    attachControl(runId, clientId, socket, initialSize) {
      const state = getOrCreateState(runId, initialSize)
      const viewer = getOrCreateViewer(state, clientId)
      viewer.controlSocket = socket
      // A viewer attaching after the exit event still needs the terminal state.
      if (state.exited && socket.readyState === socket.OPEN) {
        socket.send(serializeTerminalExit(state.exitCode))
      }
      void state.mirror
        .getSnapshot()
        .then((snapshot) => {
          if (socket.readyState === socket.OPEN) socket.send(serializeTerminalRestore(snapshot))
        })
        .catch(() => {
          if (socket.readyState === socket.OPEN) socket.send(serializeTerminalRestore(''))
        })
      socket.on('message', (raw) => {
        try {
          const message = parseTerminalControlMessage(raw as Buffer | string)
          if (message.type === 'output_ack') viewer.flowState?.ack(message.bytes)
          if (message.type === 'resize') {
            state.mirror.resize(message.cols, message.rows)
            store.resizeAgentRun(runId, message.cols, message.rows)
          }
          if (message.type === 'stop') store.stopAgentRun(runId)
          if (message.type === 'restore_complete') return
        } catch (error) {
          socket.send(
            serializeTerminalError(
              error instanceof Error ? error.message : 'Invalid control message'
            )
          )
        }
      })
      socket.on('close', () => {
        if (viewer.controlSocket === socket) viewer.controlSocket = null
        cleanupViewer(runId, state, clientId)
      })
    },
    attachIo(runId, clientId, socket, initialSize) {
      const state = getOrCreateState(runId, initialSize)
      const viewer = getOrCreateViewer(state, clientId)
      viewer.ioSocket = socket
      viewer.flowState?.close()
      viewer.flowState = createTerminalOutputFlow(socket, {
        onBackpressureChange(backpressured) {
          if (backpressured) {
            const wasEmpty = state.backpressuredViewerIds.size === 0
            state.backpressuredViewerIds.add(clientId)
            if (wasEmpty) store.pauseTerminalRun(runId)
            return
          }
          maybeResumeRun(runId, state, clientId)
        },
      })
      socket.on('message', (raw, isBinary) => {
        try {
          store.writeRunInput(runId, normalizeTerminalInput(raw, isBinary))
        } catch (error) {
          // A terminal can exit between the browser's keystroke and this
          // message handler. Report the stale input to that socket instead of
          // letting a normal PTY race crash the whole Hive runtime.
          if (socket.readyState === socket.OPEN) {
            socket.send(
              serializeTerminalError(
                error instanceof Error ? error.message : 'Terminal input failed'
              )
            )
          }
        }
      })
      socket.on('close', () => {
        if (viewer.ioSocket === socket) viewer.ioSocket = null
        viewer.flowState?.close()
        viewer.flowState = null
        cleanupViewer(runId, state, clientId)
      })
    },
    close() {
      for (const [runId, state] of runStates) {
        state.outputUnsubscribe?.()
        state.exitUnsubscribe?.()
        state.mirror.dispose()
        for (const viewer of state.viewers.values()) {
          viewer.flowState?.close()
          viewer.ioSocket?.close()
          viewer.controlSocket?.close()
        }
        runStates.delete(runId)
      }
    },
  }
}
