import { describe, expect, test, vi } from 'vitest'

import {
  createTeamMemoryDreamScheduler,
  DREAM_SCHEDULER_FLOOR_MS,
  type MemoryDreamScheduleState,
} from '../../src/server/team-memory-dream-scheduler.js'

const workspace = { id: 'workspace-1', name: 'Alpha', path: '/tmp/alpha' }

const eligibleState = (): MemoryDreamScheduleState => ({
  hasReviewDraft: false,
  hasUnreviewedActivity: true,
  lastScheduledAt: null,
})

const createScheduler = (
  input: {
    enabled?: boolean
    retryPending?: (workspaceId: string) => Promise<void>
    runScheduled?: (workspaceId: string) => Promise<unknown>
    snapshot?: { agents: Array<{ status: string }> }
    state?: MemoryDreamScheduleState
  } = {}
) => {
  const markScheduled = vi.fn()
  const scheduler = createTeamMemoryDreamScheduler({
    getScheduleState: () => input.state ?? eligibleState(),
    getWorkspaceSnapshot: () => input.snapshot ?? { agents: [] },
    isEnabled: () => input.enabled ?? true,
    listWorkspaces: () => [workspace],
    logError: vi.fn(),
    markScheduled,
    retryPending: input.retryPending ?? (async () => {}),
    runScheduled: input.runScheduled ?? vi.fn(async () => undefined),
  })
  return { markScheduled, scheduler }
}

describe('team memory Dream scheduler', () => {
  test('creates one visible review only after an enabled workspace is idle', async () => {
    const runScheduled = vi.fn(async () => undefined)
    const { markScheduled, scheduler } = createScheduler({ runScheduled })

    await scheduler.tick(0)
    expect(runScheduled).not.toHaveBeenCalled()

    await scheduler.tick(60_000)
    expect(runScheduled).toHaveBeenCalledWith(workspace.id)
    expect(markScheduled).toHaveBeenCalledWith(workspace.id, 60_000)
    await scheduler.close()
  })

  test('does not run while disabled, while an agent is working, or while a review is waiting', async () => {
    const disabled = createScheduler({ enabled: false })
    await disabled.scheduler.tick(0)
    await disabled.scheduler.tick(60_000)
    expect(disabled.markScheduled).not.toHaveBeenCalled()

    const working = createScheduler({ snapshot: { agents: [{ status: 'working' }] } })
    await working.scheduler.tick(0)
    await working.scheduler.tick(60_000)
    expect(working.markScheduled).not.toHaveBeenCalled()

    const waitingReview = createScheduler({
      state: { ...eligibleState(), hasReviewDraft: true },
    })
    await waitingReview.scheduler.tick(0)
    await waitingReview.scheduler.tick(60_000)
    expect(waitingReview.markScheduled).not.toHaveBeenCalled()

    await Promise.all([
      disabled.scheduler.close(),
      waitingReview.scheduler.close(),
      working.scheduler.close(),
    ])
  })

  test('backs off after an execution failure instead of hammering the Orchestrator', async () => {
    const runScheduled = vi.fn(async () => {
      throw new Error('temporary delivery failure')
    })
    const { scheduler } = createScheduler({ runScheduled })

    await scheduler.tick(0)
    await scheduler.tick(60_000)
    expect(runScheduled).toHaveBeenCalledTimes(1)

    await scheduler.tick(60_000 + DREAM_SCHEDULER_FLOOR_MS * 2 - 1)
    expect(runScheduled).toHaveBeenCalledTimes(1)

    await scheduler.tick(60_000 + DREAM_SCHEDULER_FLOOR_MS * 2)
    expect(runScheduled).toHaveBeenCalledTimes(2)
    await scheduler.close()
  })
  test('retries unfinished generation while a review blocks preparing another window', async () => {
    const events: string[] = []
    const { scheduler } = createScheduler({
      state: { ...eligibleState(), hasReviewDraft: true },
      retryPending: async () => {
        events.push('retry existing window')
      },
      runScheduled: async () => {
        events.push('prepare another window')
      },
    })
    await scheduler.tick(0)
    expect(events).toEqual([])
    await scheduler.tick(60_000)
    await scheduler.tick(90_000)
    expect(events).toEqual(['retry existing window', 'retry existing window'])
    await scheduler.close()
  })

  test('new evidence schedules without existing memory, while an empty window does not', async () => {
    const prepared: string[] = []
    const state = eligibleState()
    const { scheduler } = createScheduler({
      state,
      runScheduled: async (workspaceId) => {
        prepared.push(workspaceId)
      },
    })
    state.hasUnreviewedActivity = false
    await scheduler.tick(0)
    await scheduler.tick(60_000)
    expect(prepared).toEqual([])
    state.hasUnreviewedActivity = true
    await scheduler.tick(90_000)
    expect(prepared).toEqual([workspace.id])
    await scheduler.close()
  })
})
