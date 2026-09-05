type OutputListener = (chunk: string) => void
type ExitListener = () => void

export interface PtyOutputBus {
  clear: (runId: string) => void
  publish: (runId: string, chunk: string) => void
  /** Fires exactly once per run, from the PTY exit path, before `clear`. */
  publishExit: (runId: string) => void
  subscribe: (runId: string, listener: OutputListener) => () => void
  subscribeExit: (runId: string, listener: ExitListener) => () => void
}

export const createPtyOutputBus = (): PtyOutputBus => {
  const listenersByRunId = new Map<string, Set<OutputListener>>()
  const exitListenersByRunId = new Map<string, Set<ExitListener>>()

  const getListeners = (runId: string) => {
    let listeners = listenersByRunId.get(runId)
    if (!listeners) {
      listeners = new Set<OutputListener>()
      listenersByRunId.set(runId, listeners)
    }
    return listeners
  }

  return {
    clear(runId) {
      listenersByRunId.delete(runId)
      exitListenersByRunId.delete(runId)
    },
    publish(runId, chunk) {
      const listeners = listenersByRunId.get(runId)
      if (!listeners) return
      for (const listener of listeners) listener(chunk)
    },
    publishExit(runId) {
      const listeners = exitListenersByRunId.get(runId)
      if (!listeners) return
      // Exit is terminal: listeners are one-shot, so drop them before
      // notifying and let callbacks re-subscribe safely if they need to.
      exitListenersByRunId.delete(runId)
      for (const listener of listeners) listener()
    },
    subscribe(runId, listener) {
      const listeners = getListeners(runId)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) listenersByRunId.delete(runId)
      }
    },
    subscribeExit(runId, listener) {
      let listeners = exitListenersByRunId.get(runId)
      if (!listeners) {
        listeners = new Set<ExitListener>()
        exitListenersByRunId.set(runId, listeners)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) exitListenersByRunId.delete(runId)
      }
    },
  }
}
