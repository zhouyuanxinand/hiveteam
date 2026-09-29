import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PersistedAgentRun } from '../../src/server/agent-run-store.js'
import type { DispatchRecord } from '../../src/server/dispatch-ledger-store.js'
import { createMessageLogStore } from '../../src/server/message-log-store.js'
import { createRestartPolicy } from '../../src/server/restart-policy.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import type { AgentSummary } from '../../src/shared/types.js'

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
  messageProtocolVersion: 0,
  baseHeadSha: null,
  reportOutcome: null,
  reportRevision: 0,
  acceptedAt: null,
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

const databases: ReturnType<typeof openRuntimeDatabase>[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const preparedPolicy = (agent: AgentSummary = worker, runs: PersistedAgentRun[] = []) => {
  const database = openRuntimeDatabase()
  databases.push(database)
  const messages = createMessageLogStore(database)
  const work = dispatch('submitted', 'Continue the unfinished task')
  const policy = createRestartPolicy({
    deleteMessage: messages.deleteMessage,
    getWorkspaceSnapshot: () => ({ agents: [agent], summary: workspace }),
    insertMessage: messages.insertMessage,
    listAgentRuns: () => runs,
    listOpenDispatches: () => [work],
    listMessagesForRecovery: () => [],
    readTasks: () => '',
  })
  const input = {
    agentId: agent.id,
    runId: 'run-1',
    startConfig: { command: 'codex' },
    workspace,
  }
  const persisted = () => database.prepare('SELECT type,text FROM messages ORDER BY sequence').all()
  return { database, input, messages, persisted, policy, work }
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

describe('restart message preparation', () => {
  test('prepares recovery without writing, then persists the exact text with an isolated rollback', () => {
    const context = preparedPolicy()
    context.messages.insertMessage({
      workspaceId: workspace.id,
      workerId: worker.id,
      type: 'user_input',
      text: 'Keep this earlier message',
      createdAt: 1,
    })
    const previous = context.persisted()
    const plan = context.policy.preparePostStartMessage(context.input)
    expect(plan?.kind).toBe('recovery')
    if (plan?.kind !== 'recovery') throw new Error('Expected recovery plan')
    expect(plan.text).toContain('Continue the unfinished task')
    expect(plan.text).toContain('Hive session binding: workspace_id=workspace-1; agent_id=worker-1')
    expect(context.persisted()).toEqual(previous)
    context.work.text = 'Changed after preparation'
    const rollback = plan.persist()
    expect(context.persisted()).toEqual([
      ...previous,
      { type: 'system_recovery_summary', text: plan.text },
    ])
    rollback()
    expect(context.persisted()).toEqual(previous)
  })

  test('native resume skips both recovery and ordinary startup text without persistence', () => {
    const context = preparedPolicy()
    const input = {
      ...context.input,
      startConfig: { command: 'codex', resumedSessionId: 'native-session' },
    }
    expect(context.policy.preparePostStartMessage(input)).toEqual({ kind: 'skip' })
    const writes: string[] = []
    expect(
      context.policy.injectPostStartMessage({
        ...input,
        writeToRun: (_runId, text) => writes.push(text),
      })
    ).toBe(true)
    expect(writes).toEqual([])
    expect(context.persisted()).toEqual([])
  })

  test('a new orchestrator permits startup while an earlier run selects recovery', () => {
    const orchestrator: AgentSummary = {
      ...worker,
      id: `${workspace.id}:orchestrator`,
      name: 'Orchestrator',
      role: 'orchestrator',
    }
    const fresh = preparedPolicy(orchestrator)
    expect(fresh.policy.preparePostStartMessage(fresh.input)).toBeNull()
    const returning = preparedPolicy(orchestrator, [
      {
        runId: 'previous-run',
        agentId: orchestrator.id,
        startedAt: 1,
        endedAt: 2,
        pid: null,
        status: 'exited',
        exitCode: 0,
      },
    ])
    expect(returning.policy.preparePostStartMessage(returning.input)?.kind).toBe('recovery')
    expect(fresh.persisted()).toEqual([])
    expect(returning.persisted()).toEqual([])
  })

  test('legacy injection persists before writing and rolls back when the writer fails', () => {
    const context = preparedPolicy()
    const failure = new Error('PTY closed before the recovery write')
    expect(() =>
      context.policy.injectPostStartMessage({
        ...context.input,
        writeToRun: (runId, text) => {
          expect(runId).toBe(context.input.runId)
          expect(context.persisted()).toEqual([{ type: 'system_recovery_summary', text }])
          throw failure
        },
      })
    ).toThrow(failure)
    expect(context.persisted()).toEqual([])
  })

  test('a failed database write prevents any recovery input', () => {
    const context = preparedPolicy()
    context.database.pragma('query_only = ON')
    const writes: string[] = []
    expect(() =>
      context.policy.injectPostStartMessage({
        ...context.input,
        writeToRun: (_runId, text) => writes.push(text),
      })
    ).toThrow()
    expect(writes).toEqual([])
    expect(context.persisted()).toEqual([])
  })
})
