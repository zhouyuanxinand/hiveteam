import type WebSocket from 'ws'
import { RemotePermissionError } from './remote-permission-store.js'
import {
  checkTerminalRead,
  executeTerminalAction,
  observeTerminalPermissions,
  terminalGrant,
} from './remote-terminal-authorization.js'
import { getRequestPrincipal } from './request-principal.js'

import type { RuntimeStore } from './runtime-store.js'
import { createTerminalColorReplies } from './terminal-color-replies.js'
import { createTerminalOutputFlow, FLOW_CONTROL } from './terminal-flow-control.js'
import { createTerminalGrillRouter } from './terminal-grill-router.js'
import {
  parseTerminalControlMessage,
  serializeTerminalError,
  serializeTerminalExit,
  serializeTerminalRestore,
} from './terminal-protocol.js'
import { createTerminalSessionRecovery } from './terminal-session-recovery.js'
import { type TerminalMirrorSize, TerminalStateMirror } from './terminal-state-mirror.js'

interface ViewerState {
  clientId: string
  controlSocket: WebSocket | null
  flowState: ReturnType<typeof createTerminalOutputFlow> | null
  ioSocket: WebSocket | null
  coordinated: boolean
  snapshotStarted: boolean
  bootstrapChunks: string[]
  bootstrapBytes: number
  bootstrapTimer?: ReturnType<typeof setTimeout>
}

interface RunState {
  backpressuredViewerIds: Set<string>
  exited: boolean
  exitCode: number | null
  exitUnsubscribe: (() => void) | null
  mirror: TerminalStateMirror
  outputUnsubscribe: (() => void) | null
  viewers: Map<string, ViewerState>
  recovery: ReturnType<typeof createTerminalSessionRecovery> | null
  grill: ReturnType<typeof createTerminalGrillRouter> | null
  colors: ReturnType<typeof createTerminalColorReplies>
  ptyPaused: boolean
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
  metrics: () => Array<{
    run_id: string
    viewers: Array<{
      queued_bytes: number
      unacked_bytes: number
      transport_bytes: number
      backpressured: boolean
    }>
  }>
  attachControl: (
    runId: string,
    clientId: string,
    socket: WebSocket,
    initialSize?: TerminalMirrorSize,
    coordinated?: boolean
  ) => void
  attachIo: (
    runId: string,
    clientId: string,
    socket: WebSocket,
    initialSize?: TerminalMirrorSize,
    coordinated?: boolean,
    hivePort?: string
  ) => void
  close: () => void
}

export const createTerminalStreamHub = (store: RuntimeStore): TerminalStreamHub => {
  const runStates = new Map<string, RunState>()

  const updateRunPressure = (runId: string, state: RunState) => {
    const active = [...state.viewers.values()].filter(
      (viewer) => viewer.flowState && viewer.ioSocket?.readyState === viewer.ioSocket?.OPEN
    )
    const pause =
      active.length > 0 &&
      active.every((viewer) => state.backpressuredViewerIds.has(viewer.clientId))
    if (pause === state.ptyPaused) return
    state.ptyPaused = pause
    if (pause) store.pauseTerminalRun(runId)
    else store.resumeTerminalRun(runId)
  }

  const maybeResumeRun = (runId: string, state: RunState, clientId: string) => {
    state.backpressuredViewerIds.delete(clientId)
    updateRunPressure(runId, state)
  }

  const cleanupRun = (runId: string) => {
    const state = runStates.get(runId)
    if (!state?.exited || state.viewers.size > 0) return
    state.outputUnsubscribe?.()
    state.exitUnsubscribe?.()
    state.recovery?.close()
    state.grill?.close()
    state.mirror.dispose()
    runStates.delete(runId)
  }

  const getOrCreateViewer = (state: RunState, clientId: string) => {
    let viewer = state.viewers.get(clientId)
    if (!viewer) {
      viewer = {
        clientId,
        controlSocket: null,
        flowState: null,
        ioSocket: null,
        coordinated: false,
        snapshotStarted: false,
        bootstrapChunks: [],
        bootstrapBytes: 0,
      }
      state.viewers.set(clientId, viewer)
    }
    return viewer
  }

  const disconnectViewer = (
    runId: string,
    state: RunState,
    viewer: ViewerState,
    reason: string
  ) => {
    const message = `${reason}. Reconnect to restore the current terminal snapshot; older continuous history may be missing.`
    if (viewer.controlSocket?.readyState === viewer.controlSocket?.OPEN)
      viewer.controlSocket?.send(serializeTerminalError(message))
    viewer.flowState?.close()
    viewer.flowState = null
    viewer.bootstrapChunks = []
    viewer.bootstrapBytes = 0
    if (viewer.bootstrapTimer) clearTimeout(viewer.bootstrapTimer)
    for (const socket of [viewer.ioSocket, viewer.controlSocket]) {
      if (!socket) continue
      socket.close(4008, 'Terminal stream interrupted')
      const deadline = setTimeout(() => socket.terminate(), 1000)
      deadline.unref()
      socket.once('close', () => clearTimeout(deadline))
    }
    state.viewers.delete(viewer.clientId)
    maybeResumeRun(runId, state, viewer.clientId)
  }

  const checkBootstrap = (runId: string, state: RunState, viewer: ViewerState) => {
    if (viewer.bootstrapTimer) {
      clearTimeout(viewer.bootstrapTimer)
      delete viewer.bootstrapTimer
    }
    if (!viewer.coordinated || (viewer.controlSocket && viewer.ioSocket)) return
    viewer.bootstrapTimer = setTimeout(
      () => disconnectViewer(runId, state, viewer, 'Terminal connection handshake timed out'),
      FLOW_CONTROL.ACK_TIMEOUT_MS
    )
    viewer.bootstrapTimer.unref()
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
        recovery: null,
        grill: null,
        colors: createTerminalColorReplies(store, runId),
        ptyPaused: false,
      }
      runStates.set(runId, state)
      const liveRun = store.getLiveRun(runId)
      if (liveRun.output.length > 0) state.mirror.write(liveRun.output)
      const nextState = state
      nextState.grill = createTerminalGrillRouter({
        store,
        runId,
        mirror: nextState.mirror,
        broadcast(message) {
          for (const viewer of nextState.viewers.values()) {
            const socket = viewer.controlSocket
            if (
              socket &&
              socket.readyState === socket.OPEN &&
              checkTerminalRead(store, runId, socket)
            )
              socket.send(JSON.stringify(message))
          }
        },
      })
      nextState.recovery = createTerminalSessionRecovery({
        store,
        runId,
        mirror: nextState.mirror,
        broadcast(payload) {
          for (const viewer of nextState.viewers.values()) {
            const socket = viewer.controlSocket
            if (
              socket &&
              socket.readyState === socket.OPEN &&
              checkTerminalRead(store, runId, socket)
            )
              socket.send(payload)
          }
        },
      })
      nextState.outputUnsubscribe = store.getPtyOutputBus().subscribe(runId, (chunk) => {
        nextState.colors?.observeOutput(chunk)
        nextState.mirror.write(chunk)
        nextState.recovery?.observe()
        for (const viewer of nextState.viewers.values()) {
          if (viewer.coordinated && !viewer.snapshotStarted) continue
          if (viewer.ioSocket && checkTerminalRead(store, runId, viewer.ioSocket))
            viewer.flowState?.enqueue(chunk)
          else if (
            viewer.coordinated &&
            viewer.controlSocket &&
            checkTerminalRead(store, runId, viewer.controlSocket)
          ) {
            viewer.bootstrapBytes += Buffer.byteLength(chunk)
            if (viewer.bootstrapBytes > FLOW_CONTROL.VIEWER_MAX_BYTES)
              disconnectViewer(runId, nextState, viewer, 'Terminal bootstrap buffer limit exceeded')
            else viewer.bootstrapChunks.push(chunk)
          }
        }
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
        nextState.recovery.close()
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
    if (viewer.bootstrapTimer) clearTimeout(viewer.bootstrapTimer)
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
    state.recovery?.close()
    state.grill?.close()
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
    metrics: () =>
      [...runStates].map(([runId, state]) => ({
        run_id: runId,
        viewers: [...state.viewers.values()].flatMap((viewer) =>
          viewer.flowState ? [viewer.flowState.metrics()] : []
        ),
      })),
    attachControl(runId, clientId, socket, initialSize, coordinated = false) {
      const state = getOrCreateState(runId, initialSize)
      const previous = state.viewers.get(clientId)
      if (previous?.controlSocket)
        disconnectViewer(runId, state, previous, 'Terminal client ID was replaced')
      const viewer = getOrCreateViewer(state, clientId)
      viewer.coordinated ||= coordinated
      viewer.controlSocket = socket
      if (state.grill?.current) socket.send(JSON.stringify(state.grill.current))
      checkBootstrap(runId, state, viewer)
      observeTerminalPermissions(store, runId, socket, true)
      // A viewer attaching after the exit event still needs the terminal state.
      if (state.exited && socket.readyState === socket.OPEN) {
        socket.send(serializeTerminalExit(state.exitCode))
      }
      const snapshotPromise = state.mirror.getSnapshot()
      viewer.snapshotStarted = true
      void snapshotPromise
        .then(async (snapshot) => {
          if (viewer.controlSocket !== socket || !checkTerminalRead(store, runId, socket)) return
          if (socket.readyState === socket.OPEN) socket.send(serializeTerminalRestore(snapshot))
          await state.recovery?.sendCurrent(socket)
        })
        .catch((error: unknown) => {
          if (socket.readyState === socket.OPEN)
            socket.send(
              serializeTerminalError(
                error instanceof Error ? error.message : 'Unable to restore terminal'
              )
            )
        })
      socket.on('message', (raw) => {
        if (viewer.controlSocket !== socket || state.viewers.get(clientId) !== viewer) return
        try {
          const message = parseTerminalControlMessage(raw as Buffer | string)
          if (message.type === 'output_ack') viewer.flowState?.ack(message.bytes)
          if (message.type === 'resize') {
            executeTerminalAction(store, runId, socket, 'terminal_resize', () => {
              state.mirror.resize(message.cols, message.rows)
              store.resizeAgentRun(runId, message.cols, message.rows)
            })
          }
          if (message.type === 'stop')
            executeTerminalAction(store, runId, socket, 'agent_stop', () =>
              store.stopAgentRun(runId)
            )
          if (message.type === 'restore_complete') return
          if (message.type === 'retry_session') {
            const grant = terminalGrant(store, runId, socket, 'session_retry')
            void state.recovery
              ?.retry(socket, message.request_id, (write) => {
                const current = terminalGrant(store, runId, socket, 'session_retry')
                if (current !== grant)
                  throw new RemotePermissionError(
                    'remote_grant_expired',
                    'Session retry authorization expired'
                  )
                executeTerminalAction(store, runId, socket, 'session_retry', write, 1)
              })
              .catch((error: unknown) => {
                if (socket.readyState === socket.OPEN)
                  socket.send(
                    serializeTerminalError(
                      error instanceof Error ? error.message : 'Session retry failed'
                    )
                  )
              })
          }
        } catch (error) {
          socket.send(
            serializeTerminalError(
              error instanceof Error ? error.message : 'Invalid control message'
            )
          )
        }
      })
      socket.on('close', () => {
        if (state.viewers.get(clientId) !== viewer) return
        if (viewer.controlSocket === socket) viewer.controlSocket = null
        cleanupViewer(runId, state, clientId)
      })
    },
    attachIo(runId, clientId, socket, initialSize, coordinated = false, hivePort = '') {
      const state = getOrCreateState(runId, initialSize)
      const previous = state.viewers.get(clientId)
      if (previous?.ioSocket)
        disconnectViewer(runId, state, previous, 'Terminal client ID was replaced')
      const viewer = getOrCreateViewer(state, clientId)
      viewer.coordinated ||= coordinated
      viewer.ioSocket = socket
      checkBootstrap(runId, state, viewer)
      observeTerminalPermissions(store, runId, socket, false)
      viewer.flowState?.close()
      viewer.flowState = createTerminalOutputFlow(socket, {
        onBackpressureChange(backpressured) {
          if (backpressured) {
            state.backpressuredViewerIds.add(clientId)
            updateRunPressure(runId, state)
            return
          }
          maybeResumeRun(runId, state, clientId)
        },
        onOverflow(reason) {
          disconnectViewer(runId, state, viewer, reason)
        },
      })
      updateRunPressure(runId, state)
      for (const chunk of viewer.bootstrapChunks) viewer.flowState?.enqueue(chunk)
      viewer.bootstrapChunks = []
      viewer.bootstrapBytes = 0
      socket.on('message', (raw, isBinary) => {
        if (viewer.ioSocket !== socket || state.viewers.get(clientId) !== viewer) return
        try {
          const received = normalizeTerminalInput(raw, isBinary)
          terminalGrant(store, runId, socket, 'terminal_input', Buffer.byteLength(received))
          const input = state.colors?.filter(received) ?? received
          if (input.length === 0) return
          state.grill?.accept(input, {
            hivePort,
            isCurrent: () =>
              viewer.ioSocket === socket &&
              state.viewers.get(clientId) === viewer &&
              socket.readyState === socket.OPEN,
            write: (data) =>
              executeTerminalAction(
                store,
                runId,
                socket,
                'terminal_input',
                () => store.writeRunInput(runId, data),
                Buffer.byteLength(data)
              ),
            assertHandoff() {
              if (getRequestPrincipal(socket)?.kind === 'remote_device')
                throw new RemotePermissionError(
                  'remote_action_forbidden',
                  'Start an interview from the local HiveTeam window. Terminal input permission does not authorize automatic member creation.'
                )
            },
          })
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
        if (viewer.ioSocket !== socket || state.viewers.get(clientId) !== viewer) return
        viewer.ioSocket = null
        viewer.flowState?.close()
        viewer.flowState = null
        cleanupViewer(runId, state, clientId)
      })
    },
    close() {
      for (const [runId, state] of runStates) {
        state.outputUnsubscribe?.()
        state.exitUnsubscribe?.()
        state.recovery?.close()
        state.grill?.close()
        state.mirror.dispose()
        for (const viewer of state.viewers.values()) {
          if (viewer.bootstrapTimer) clearTimeout(viewer.bootstrapTimer)
          viewer.flowState?.close()
          viewer.ioSocket?.close()
          viewer.controlSocket?.close()
        }
        runStates.delete(runId)
      }
    },
  }
}
