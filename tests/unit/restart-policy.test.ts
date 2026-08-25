import { describe, expect, test, vi } from 'vitest'

import type { DispatchRecord } from '../../src/server/dispatch-ledger-store.js'
import { createRestartPolicy } from '../../src/server/restart-policy.js'

const workspace = {
  id: 'workspace-1',
  name: 'Alpha',
  path: '/tmp/hive-alpha',
}
const worker = {
  description: 'You are a Coder.',
  id: 'worker-1',
  name: 'Alice',
  pendingTaskCount: 1,
  role: 'coder' as const,
  status: 'stopped' as const,
  workspaceId: workspace.id,
}
const snapshot = {
  agents: [worker],
  summary: workspace,
}

const dispatch = (status: DispatchRecord['status'], text: string): DispatchRecord => ({
  artifacts: [],
  createdAt: Date.now(),
  deliveredAt: null,
  fromAgentId: `${workspace.id}:orchestrator`,
  id: `dispatch-${status}`,
  reportedAt: status === 'reported' ? Date.now() : null,
  reportText: status === 'reported' ? 'Done' : null,
  sequence: 1,
  status,
  submittedAt: status === 'submitted' ? Date.now() : null,
  text,
  toAgentId: worker.id,
  workspaceId: workspace.id,
})

const runPolicy = (openDispatches: DispatchRecord[]) => {
  const writes: string[] = []
  const policy = createRestartPolicy({
    deleteMessage: vi.fn(),
    getWorkspaceSnapshot: () => snapshot,
    insertMessage: vi.fn(() => ({ sequence: 1 })),
    listAgentRuns: () => [],
    listOpenDispatches: () => openDispatches,
    listMessagesForRecovery: () => [],
    readTasks: () => '',
  })
  const handled = policy.injectPostStartMessage({
    agentId: worker.id,
    runId: 'run-1',
    startConfig: { command: 'codex' },
    workspace,
    writeToRun: (_runId, text) => writes.push(text),
  })
  return { handled, writes }
}

describe('restart policy dispatch filtering', () => {
  test('does not recover cancelled or reported historical dispatches', () => {
    const result = runPolicy([
      dispatch('cancelled', 'cancelled task'),
      dispatch('reported', 'completed task'),
    ])

    expect(result.handled).toBe(false)
    expect(result.writes).toEqual([])
  })

  test('leaves queued dispatch replay to the lifecycle and recovers submitted work', () => {
    const queued = runPolicy([dispatch('queued', 'queued task')])
    expect(queued.handled).toBe(false)
    expect(queued.writes).toEqual([])

    const submitted = runPolicy([dispatch('submitted', 'submitted task')])
    expect(submitted.handled).toBe(true)
    expect(submitted.writes[0]).toContain('submitted task')
    expect(submitted.writes[0]).toContain(
      'Hive session binding: workspace_id=workspace-1; agent_id=worker-1'
    )
  })
})
