import type WebSocket from 'ws'
import type {
  TerminalSessionRecovery,
  TerminalSessionRetryStatus,
} from '../shared/terminal-recovery.js'
import type { RuntimeStore } from './runtime-store.js'
import type { TerminalStateMirror } from './terminal-state-mirror.js'

const RETRY_SETTLE_MS = 1500

const findCodexContext = (store: RuntimeStore, runId: string) => {
  for (const workspace of store.listWorkspaces()) {
    const summary = store.listTerminalRuns(workspace.id).find((run) => run.run_id === runId)
    if (!summary) continue
    const config = store.peekAgentLaunchConfig(workspace.id, summary.agent_id)
    const executable = (config?.interactiveCommand ?? config?.command ?? '').split(/[\\/]/).at(-1)
    if (
      config?.commandPresetId !== 'codex' &&
      config?.sessionIdCapture?.source !== 'codex_session_jsonl_dir' &&
      !/^codex(?:\.(?:cmd|exe))?$/i.test(executable ?? '')
    )
      return null
    return () =>
      store.listTerminalRuns(workspace.id).find((run) => run.run_id === runId)?.thread_id ?? null
  }
  return null
}

// Read the current screen, not accumulated output or lock-file existence.
// Native Codex owns the OS lock and remains the authority for retrying it.
export const hasCodexOwnershipPrompt = (screen: string): boolean => {
  const compact = screen.replace(/\s+/g, ' ').trim()
  return (
    /This conversation is open in another app\s+(?:R to Retry\s+)?Close it there and press R to continue here\./i.test(
      compact
    ) && /r retry\s+esc\/ctrl\+c\/q exit\s+ctrl\+t transcript\s*$/i.test(compact)
  )
}

export const createTerminalSessionRecovery = ({
  store,
  runId,
  mirror,
  broadcast,
}: {
  store: RuntimeStore
  runId: string
  mirror: TerminalStateMirror
  broadcast: (payload: string) => void
}) => {
  const getThreadId = findCodexContext(store, runId)
  let current: TerminalSessionRecovery | null = null
  let closed = false
  let observing = false
  let observeAgain = false
  let retrying = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let finishSettle: (() => void) | undefined
  const send = (socket: WebSocket, payload: object) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
  }
  const read = async (): Promise<TerminalSessionRecovery | null> => {
    if (!getThreadId || closed) return null
    const screen = await mirror.getScreenText()
    if (closed || !hasCodexOwnershipPrompt(screen)) return null
    const run = store.getLiveRun(runId)
    if (run.status === 'exited' || run.status === 'error') return null
    return { kind: 'codex_session_in_use', thread_id: getThreadId() }
  }
  const publish = (next: TerminalSessionRecovery | null) => {
    if (current?.kind === next?.kind && current?.thread_id === next?.thread_id) return
    current = next
    broadcast(JSON.stringify({ type: 'session_recovery', recovery: next }))
  }
  const observe = () => {
    if (!getThreadId || closed || retrying) return
    if (observing) {
      observeAgain = true
      return
    }
    observing = true
    observeAgain = false
    void read()
      .then((next) => {
        // A native retry may clear and repaint in separate PTY frames. Keep
        // the warning mounted until that attempt returns its settled result.
        if (!retrying) publish(next)
      })
      .catch((error: unknown) => {
        broadcast(
          JSON.stringify({
            type: 'error',
            message:
              error instanceof Error ? error.message : 'Unable to inspect session recovery state',
          })
        )
      })
      .finally(() => {
        observing = false
        if (observeAgain) observe()
      })
  }
  return {
    observe,
    async sendCurrent(socket: WebSocket) {
      const recovery = retrying ? current : await read()
      if (retrying) {
        if (current) send(socket, { type: 'session_recovery', recovery: current })
        return
      }
      const unchanged =
        current?.kind === recovery?.kind && current?.thread_id === recovery?.thread_id
      publish(recovery)
      if (recovery && unchanged) send(socket, { type: 'session_recovery', recovery })
    },
    async retry(socket: WebSocket, requestId: string) {
      const reply = (status: TerminalSessionRetryStatus) =>
        send(socket, { type: 'session_retry', request_id: requestId, status })
      if (!getThreadId || closed) {
        reply('unavailable')
        return
      }
      if (retrying) {
        reply('retry_pending')
        return
      }
      retrying = true
      try {
        const recovery = await read()
        if (closed) {
          reply('unavailable')
          return
        }
        publish(recovery)
        if (!recovery) {
          reply('not_locked')
          return
        }
        // No await between the fresh screen check and the write. Concurrent
        // viewers share this guard; stale clicks never type into a composer.
        store.writeRunInput(runId, 'r')
        await new Promise<void>((resolve) => {
          finishSettle = resolve
          settleTimer = setTimeout(resolve, RETRY_SETTLE_MS)
        })
        const next = await read()
        publish(next)
        reply(closed ? 'unavailable' : next ? 'still_locked' : 'prompt_cleared')
      } finally {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = undefined
        finishSettle = undefined
        retrying = false
        observe()
      }
    },
    close() {
      closed = true
      if (settleTimer) clearTimeout(settleTimer)
      finishSettle?.()
      publish(null)
    },
  }
}
