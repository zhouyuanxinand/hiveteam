import type { WorkspaceSummary } from '../shared/types.js'

/** Do not generate review drafts more often than once per twenty minutes. */
export const DREAM_SCHEDULER_FLOOR_MS = 20 * 60 * 1_000
export const DREAM_SCHEDULER_IDLE_DEBOUNCE_MS = 60 * 1_000
export const DREAM_SCHEDULER_TICK_INTERVAL_MS = 30 * 1_000
export const DREAM_SCHEDULER_BACKOFF_CAP = 5

export interface MemoryDreamScheduleState {
  /** A visible draft already exists and must be reviewed before another can be prepared. */
  hasReviewDraft: boolean
  /** Dream only consolidates existing, active memory; never create empty drafts. */
  hasSourceMemory: boolean
  /** New user/team activity has occurred after the prior scheduled review. */
  hasUnreviewedActivity: boolean
  lastScheduledAt: number | null
}

interface WorkspaceSnapshot {
  agents: Array<{ status: string }>
}

export interface TeamMemoryDreamSchedulerDeps {
  getScheduleState: (workspaceId: string) => MemoryDreamScheduleState
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceSnapshot
  isEnabled: (workspaceId: string) => boolean
  listWorkspaces: () => WorkspaceSummary[]
  logError?: (workspaceId: string, error: unknown) => void
  markScheduled: (workspaceId: string, timestamp: number) => void
  now?: () => number
  runScheduled: (workspaceId: string) => Promise<unknown>
}

export interface TeamMemoryDreamScheduler {
  close: () => Promise<void>
  start: (input?: { tickIntervalMs?: number }) => void
  tick: (timestamp?: number) => Promise<void>
}

const hasWorkingAgent = (snapshot: WorkspaceSnapshot) =>
  snapshot.agents.some((agent) => agent.status === 'working')

export const createTeamMemoryDreamScheduler = (
  deps: TeamMemoryDreamSchedulerDeps
): TeamMemoryDreamScheduler => {
  const now = deps.now ?? (() => Date.now())
  const logError =
    deps.logError ??
    ((workspaceId: string, error: unknown) => {
      console.error('[hiveteam] memory Dream scheduler failed', { error, workspaceId })
    })
  const idleSinceByWorkspace = new Map<string, number>()
  const failuresByWorkspace = new Map<string, number>()
  const lastAttemptedAtByWorkspace = new Map<string, number>()
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let tickInFlight: Promise<void> | null = null

  const clearTimer = () => {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }

  const effectiveFloor = (workspaceId: string) =>
    DREAM_SCHEDULER_FLOOR_MS *
    2 ** Math.min(failuresByWorkspace.get(workspaceId) ?? 0, DREAM_SCHEDULER_BACKOFF_CAP)

  const scheduler: TeamMemoryDreamScheduler = {
    async close() {
      closed = true
      clearTimer()
      await tickInFlight?.catch((error: unknown) => {
        console.error('[hiveteam] swallowed:memory-dream-scheduler.close', error)
      })
    },
    start({ tickIntervalMs = DREAM_SCHEDULER_TICK_INTERVAL_MS } = {}) {
      closed = false
      clearTimer()
      timer = setInterval(() => {
        void scheduler.tick().catch((error: unknown) => {
          console.error('[hiveteam] swallowed:memory-dream-scheduler.tick', error)
        })
      }, tickIntervalMs)
      timer.unref?.()
    },
    async tick(timestamp = now()) {
      if (closed) return
      if (tickInFlight) return tickInFlight

      const pendingTick = (async () => {
        for (const workspace of deps.listWorkspaces()) {
          try {
            if (!deps.isEnabled(workspace.id)) {
              idleSinceByWorkspace.delete(workspace.id)
              continue
            }

            if (hasWorkingAgent(deps.getWorkspaceSnapshot(workspace.id))) {
              idleSinceByWorkspace.delete(workspace.id)
              continue
            }

            const previousIdleSince = idleSinceByWorkspace.get(workspace.id)
            const idleSince =
              previousIdleSince === undefined || timestamp < previousIdleSince
                ? timestamp
                : previousIdleSince
            idleSinceByWorkspace.set(workspace.id, idleSince)
            if (timestamp - idleSince < DREAM_SCHEDULER_IDLE_DEBOUNCE_MS) continue

            const state = deps.getScheduleState(workspace.id)
            if (!state.hasSourceMemory || state.hasReviewDraft || !state.hasUnreviewedActivity) {
              continue
            }
            const mostRecentAttemptAt = Math.max(
              state.lastScheduledAt ?? 0,
              lastAttemptedAtByWorkspace.get(workspace.id) ?? 0
            )
            if (
              mostRecentAttemptAt > 0 &&
              timestamp - mostRecentAttemptAt < effectiveFloor(workspace.id)
            ) {
              continue
            }

            lastAttemptedAtByWorkspace.set(workspace.id, timestamp)
            await deps.runScheduled(workspace.id)
            deps.markScheduled(workspace.id, timestamp)
            failuresByWorkspace.delete(workspace.id)
            lastAttemptedAtByWorkspace.delete(workspace.id)
          } catch (error) {
            failuresByWorkspace.set(workspace.id, (failuresByWorkspace.get(workspace.id) ?? 0) + 1)
            logError(workspace.id, error)
          }
        }
      })().finally(() => {
        tickInFlight = null
      })

      tickInFlight = pendingTick
      return pendingTick
    },
  }

  return scheduler
}
