import { randomUUID } from 'node:crypto'

import type { GitWorkspaceService } from './git-workspace-service.js'
import { hasInteractivePromptReady } from './post-start-input-writer.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import type { WorkspaceStore } from './workspace-store-contract.js'

const OUTPUT_TAIL_LIMIT = 64 * 1024
const TURN_SETTLE_DELAY_MS = 1500

interface ActiveTurn {
  baselineHead: string | null
  ending: boolean
  settleTimer: ReturnType<typeof setTimeout> | null
  sawOutputAfterInput: boolean
  turnId: string
}

interface TrackedRun {
  activeTurn: ActiveTurn | null
  agentId: string
  command: string
  outputTail: string
  pendingInputCount: number
  runId: string
  snapshotChain: Promise<void>
  unsubscribe: () => void
  workspaceId: string
  workspacePath: string
}

export interface GitTurnCoordinator {
  attach: (input: {
    agentId: string
    command: string
    initialOutput: string
    runId: string
    workspaceId: string
    workspacePath: string
  }) => void
  close: () => void
  detach: (workspaceId: string, agentId: string) => void
  recordInput: (workspaceId: string, agentId: string, text: string) => void
}

const runKey = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`

const appendTail = (current: string, chunk: string) => {
  const combined = current + chunk
  return combined.length > OUTPUT_TAIL_LIMIT
    ? combined.slice(combined.length - OUTPUT_TAIL_LIMIT)
    : combined
}

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const createGitTurnCoordinator = (input: {
  git: GitWorkspaceService
  outputBus: PtyOutputBus | null
  workspaceStore: WorkspaceStore
}): GitTurnCoordinator => {
  const tracked = new Map<string, TrackedRun>()

  const clearSettleTimer = (turn: ActiveTurn) => {
    if (turn.settleTimer === null) return
    clearTimeout(turn.settleTimer)
    turn.settleTimer = null
  }

  const runSnapshot = async (run: TrackedRun, turn: ActiveTurn) => {
    try {
      const workspace = input.workspaceStore.getWorkspaceSnapshot(run.workspaceId)
      const status = await input.git.getStatus(run.workspaceId, workspace.summary.path)
      if (!status.autoSnapshotEnabled || status.state !== 'ready') return
      const result = await input.git.createSnapshot({
        expectedHead: turn.baselineHead,
        message: `HiveTeam: Orchestrator turn ${turn.turnId.slice(0, 8)}`,
        turnId: turn.turnId,
        workspaceId: run.workspaceId,
        workspacePath: workspace.summary.path,
      })
      if (result.outcome === 'created' && result.commit) {
        console.info('[hive] Orchestrator turn snapshot created', {
          commitSha: result.commit.sha,
          turnId: turn.turnId,
          workspaceId: run.workspaceId,
        })
      }
    } catch (error) {
      console.warn('[hive] Orchestrator turn snapshot skipped', {
        error: getErrorMessage(error),
        turnId: turn.turnId,
        workspaceId: run.workspaceId,
      })
    }
  }

  const finishTurn = (run: TrackedRun, turn: ActiveTurn) => {
    if (turn.ending) return
    turn.ending = true
    clearSettleTimer(turn)
    const queuedSnapshot = run.snapshotChain.then(
      () => runSnapshot(run, turn),
      () => runSnapshot(run, turn)
    )
    run.snapshotChain = queuedSnapshot.catch(() => {})
    void queuedSnapshot.finally(() => {
      if (run.activeTurn === turn) run.activeTurn = null
    })
  }

  function drainPendingInput(run: TrackedRun) {
    if (run.activeTurn || run.pendingInputCount === 0) return
    run.pendingInputCount -= 1
    startTurn(run)
  }

  function startTurn(run: TrackedRun) {
    const turn: ActiveTurn = {
      baselineHead: null,
      ending: false,
      settleTimer: null,
      sawOutputAfterInput: false,
      turnId: randomUUID(),
    }
    run.activeTurn = turn
    run.outputTail = ''
    void run.snapshotChain
      .then(() => input.git.getStatus(run.workspaceId, run.workspacePath))
      .then((status) => {
        if (run.activeTurn !== turn) return
        if (!status.autoSnapshotEnabled || status.state !== 'ready') {
          run.activeTurn = null
          drainPendingInput(run)
          return
        }
        turn.baselineHead = status.headSha
      })
      .catch((error: unknown) => {
        if (run.activeTurn !== turn) return
        run.activeTurn = null
        drainPendingInput(run)
        console.warn('[hive] could not prepare Orchestrator turn snapshot', {
          error: getErrorMessage(error),
          turnId: turn.turnId,
          workspaceId: run.workspaceId,
        })
      })
  }

  const scheduleFinish = (run: TrackedRun) => {
    const turn = run.activeTurn
    if (!turn || turn.ending || !turn.sawOutputAfterInput) return
    if (turn.settleTimer !== null) clearSettleTimer(turn)
    turn.settleTimer = setTimeout(() => {
      turn.settleTimer = null
      finishTurn(run, turn)
    }, TURN_SETTLE_DELAY_MS)
  }

  const onOutput = (run: TrackedRun, chunk: string) => {
    run.outputTail = appendTail(run.outputTail, chunk)
    const turn = run.activeTurn
    if (!turn || turn.ending) return
    turn.sawOutputAfterInput = true
    if (hasInteractivePromptReady(run.outputTail, run.command)) {
      scheduleFinish(run)
    } else {
      clearSettleTimer(turn)
    }
  }

  const disposeRun = (run: TrackedRun) => {
    run.unsubscribe()
    if (run.activeTurn) clearSettleTimer(run.activeTurn)
    run.activeTurn = null
    run.pendingInputCount = 0
  }

  return {
    attach(attachInput) {
      if (!input.outputBus) return
      const key = runKey(attachInput.workspaceId, attachInput.agentId)
      const existing = tracked.get(key)
      if (existing) disposeRun(existing)
      const run: TrackedRun = {
        activeTurn: null,
        agentId: attachInput.agentId,
        command: attachInput.command,
        outputTail: attachInput.initialOutput.slice(-OUTPUT_TAIL_LIMIT),
        pendingInputCount: 0,
        runId: attachInput.runId,
        snapshotChain: Promise.resolve(),
        unsubscribe: () => {},
        workspaceId: attachInput.workspaceId,
        workspacePath: attachInput.workspacePath,
      }
      run.unsubscribe = input.outputBus.subscribe(attachInput.runId, (chunk) => {
        onOutput(run, chunk)
      })
      tracked.set(key, run)
    },
    close() {
      for (const run of tracked.values()) disposeRun(run)
      tracked.clear()
    },
    detach(workspaceId, agentId) {
      const key = runKey(workspaceId, agentId)
      const run = tracked.get(key)
      if (!run) return
      disposeRun(run)
      tracked.delete(key)
    },
    recordInput(workspaceId, agentId, text) {
      if (text.trim().length === 0) return
      const run = tracked.get(runKey(workspaceId, agentId))
      if (!run) return
      const activeTurn = run.activeTurn
      if (!activeTurn) {
        startTurn(run)
        return
      }
      if (activeTurn.ending) {
        startTurn(run)
        return
      }
      if (activeTurn.settleTimer !== null && activeTurn.sawOutputAfterInput) {
        finishTurn(run, activeTurn)
        startTurn(run)
        return
      }
      run.pendingInputCount += 1
    },
  }
}
