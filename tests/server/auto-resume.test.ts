import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import type { AgentManager, AgentRunSnapshot } from '../../src/server/agent-manager.js'
import { createPtyOutputBus } from '../../src/server/pty-output-bus.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

const waitFor = async (assertion: () => void, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

const createFakeAgentManager = () => {
  const outputBus = createPtyOutputBus()
  const runs = new Map<string, AgentRunSnapshot>()
  const exitHandlers = new Map<
    string,
    (event: { runId: string; exitCode: number | null }) => void
  >()
  const writes: string[] = []
  let nextRun = 1

  const manager: AgentManager = {
    getOutputBus: () => outputBus,
    pauseRun: () => {},
    resizeRun: () => {},
    resumeRun: () => {},
    async startAgent(input) {
      const runId = `fake-run-${nextRun++}`
      const run: AgentRunSnapshot = {
        agentId: input.agentId,
        exitCode: null,
        output: '',
        pid: nextRun,
        runId,
        status: 'running',
      }
      runs.set(runId, run)
      if (input.onExit) exitHandlers.set(runId, input.onExit)
      return run
    },
    writeInput(_runId, input) {
      writes.push(String(input))
    },
    getRun(runId) {
      const run = runs.get(runId)
      if (!run) throw new Error(`Run not found: ${runId}`)
      return run
    },
    removeRun(runId) {
      runs.delete(runId)
      exitHandlers.delete(runId)
    },
    stopRun(runId) {
      const run = runs.get(runId)
      if (!run || run.status === 'exited') return
      run.status = 'exited'
      run.exitCode = 0
      exitHandlers.get(runId)?.({ exitCode: 0, runId })
    },
  }

  return { manager, writes }
}

const insertInterruptedRun = (
  dataDir: string,
  agentId: string,
  runId: string,
  consecutiveFastExits = 0
) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  const startedAt = Date.now() - 1000
  db.prepare(
    `INSERT INTO agent_runs (
       run_id, agent_id, pid, status, exit_code, started_at, ended_at,
       consecutive_fast_exits, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    agentId,
    123,
    'running',
    null,
    startedAt,
    null,
    consecutiveFastExits,
    startedAt,
    startedAt
  )
  db.close()
}

const insertQueuedDispatch = (
  dataDir: string,
  workspaceId: string,
  fromAgentId: string,
  toAgentId: string,
  id: string,
  text: string
) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  db.prepare(
    `INSERT INTO dispatches (
       id, workspace_id, from_agent_id, to_agent_id, text, status, created_at,
       delivered_at, submitted_at, reported_at, report_text, artifacts
     ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL, NULL, '[]')`
  ).run(id, workspaceId, fromAgentId, toAgentId, text, Date.now())
  db.close()
}

const createFixture = async (autoResumeOnRestart = true) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-auto-resume-'))
  const workspacePath = join(dataDir, 'workspace')
  const scriptPath = join(dataDir, 'fake-agent.js')
  mkdirSync(workspacePath, { recursive: true })
  writeFileSync(scriptPath, 'process.stdin.resume(); setInterval(() => {}, 1000)\n')
  tempDirs.push(dataDir)

  const firstStore = createRuntimeStore({ dataDir })
  const workspace = firstStore.createWorkspace(workspacePath, 'Recovery')
  const worker = firstStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  const orchestrator = firstStore.getWorkspaceSnapshot(workspace.id).agents[0]
  if (!orchestrator) throw new Error('Expected Orchestrator')

  const launchConfig = { args: [scriptPath], command: process.execPath }
  firstStore.configureAgentLaunch(workspace.id, orchestrator.id, launchConfig)
  firstStore.configureAgentLaunch(workspace.id, worker.id, launchConfig)
  if (!autoResumeOnRestart) firstStore.setAutoResumeOnRestart(workspace.id, false)
  await firstStore.close()

  return { dataDir, orchestrator, worker, workspace }
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

describe('auto-resume recovery', () => {
  test('restores interrupted agents in orchestrator-first order', async () => {
    const fixture = await createFixture()
    insertInterruptedRun(fixture.dataDir, fixture.worker.id, 'interrupted-worker')
    insertInterruptedRun(fixture.dataDir, fixture.orchestrator.id, 'interrupted-orchestrator')

    const { manager } = createFakeAgentManager()
    const startedAgentIds: string[] = []
    const originalStartAgent = manager.startAgent
    manager.startAgent = async (input) => {
      startedAgentIds.push(input.agentId)
      return originalStartAgent(input)
    }

    const store = createRuntimeStore({ agentManager: manager, dataDir: fixture.dataDir })
    stores.push(store)
    const results = await store.autoResumeInterruptedAgents({ hivePort: '4010' })

    expect(startedAgentIds).toEqual([fixture.orchestrator.id, fixture.worker.id])
    expect(results).toEqual([
      expect.objectContaining({ agentId: fixture.orchestrator.id, ok: true }),
      expect.objectContaining({ agentId: fixture.worker.id, ok: true }),
    ])
  })

  test('honors the workspace auto-resume toggle', async () => {
    const fixture = await createFixture(false)
    insertInterruptedRun(fixture.dataDir, fixture.worker.id, 'disabled-worker')

    const { manager } = createFakeAgentManager()
    let startCount = 0
    const originalStartAgent = manager.startAgent
    manager.startAgent = async (input) => {
      startCount += 1
      return originalStartAgent(input)
    }

    const store = createRuntimeStore({ agentManager: manager, dataDir: fixture.dataDir })
    stores.push(store)
    await expect(store.autoResumeInterruptedAgents({ hivePort: '4010' })).resolves.toEqual([
      expect.objectContaining({
        agentId: fixture.worker.id,
        error: 'Workspace auto-resume is disabled.',
        ok: false,
      }),
    ])
    expect(startCount).toBe(0)
  })

  test('blocks automatic recovery after three fast exits but manual start resets the counter', async () => {
    const fixture = await createFixture()
    insertInterruptedRun(fixture.dataDir, fixture.worker.id, 'fast-exit-worker', 3)

    const { manager } = createFakeAgentManager()
    const store = createRuntimeStore({ agentManager: manager, dataDir: fixture.dataDir })
    stores.push(store)

    await expect(store.autoResumeInterruptedAgents({ hivePort: '4010' })).resolves.toEqual([
      expect.objectContaining({
        agentId: fixture.worker.id,
        error: expect.stringContaining('repeated fast exits'),
        ok: false,
      }),
    ])

    await store.startAgent(fixture.workspace.id, fixture.worker.id, { hivePort: '4010' })
    const db = new Database(join(fixture.dataDir, 'runtime.sqlite'), { readonly: true })
    const rows = db
      .prepare('SELECT consecutive_fast_exits FROM agent_runs WHERE agent_id = ?')
      .all(fixture.worker.id) as Array<{ consecutive_fast_exits: number }>
    db.close()

    expect(rows.every((row) => row.consecutive_fast_exits === 0)).toBe(true)
  })

  test('replays a queued dispatch once a worker has resumed', async () => {
    const fixture = await createFixture()
    insertQueuedDispatch(
      fixture.dataDir,
      fixture.workspace.id,
      fixture.orchestrator.id,
      fixture.worker.id,
      'queued-after-restart',
      'Continue the interrupted implementation'
    )

    const { manager, writes } = createFakeAgentManager()
    const store = createRuntimeStore({ agentManager: manager, dataDir: fixture.dataDir })
    stores.push(store)
    await store.startAgent(fixture.workspace.id, fixture.worker.id, { hivePort: '4010' })

    await waitFor(() => {
      expect(
        store
          .listDispatches(fixture.workspace.id)
          .find((item) => item.id === 'queued-after-restart')
      ).toMatchObject({ status: 'submitted' })
    })

    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('Continue the interrupted implementation')
  })
})
