import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AgentManager, AgentRunSnapshot } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

const tempDirs: string[] = []
const outputBus = {
  clear: () => {},
  publish: () => {},
  publishExit: () => {},
  subscribe: () => () => {},
  subscribeExit: () => () => {},
}

const createFakeAgentManager = (): AgentManager => {
  const runs = new Map<string, AgentRunSnapshot>()

  return {
    getOutputBus() {
      return outputBus
    },
    pauseRun() {},
    resizeRun() {},
    resumeRun() {},
    getRun(runId) {
      const run = runs.get(runId)
      if (!run) {
        throw new Error(`Run not found: ${runId}`)
      }
      return run
    },
    removeRun(runId) {
      runs.delete(runId)
    },
    async startAgent(input) {
      const run = {
        agentId: input.agentId,
        exitCode: null,
        output: '',
        pid: 1,
        runId: `run-${input.agentId}`,
        status: 'starting' as const,
      }
      runs.set(run.runId, run)
      return run
    },
    stopRun() {},
    writeInput() {},
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('runtime store', () => {
  test('can create workspace', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')

    expect(workspace).toMatchObject({
      name: 'Alpha',
      path: '/tmp/hive-alpha',
    })
  })

  test('createWorkspace does not mutate memory when DB insert fails', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-create-workspace-db-fail-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    const workspaceStore = createWorkspaceStore(db, [])
    const originalPrepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((source: string) => {
      if (source.startsWith('INSERT INTO workspaces')) {
        throw new Error('insert workspace failed')
      }
      return originalPrepare(source)
    })

    expect(() => workspaceStore.createWorkspace('/tmp/hive-alpha', 'Alpha')).toThrow(
      /insert workspace failed/
    )
    expect(workspaceStore.listWorkspaces()).toEqual([])

    db.close()
  })

  test('each workspace automatically has one orchestrator', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const snapshot = store.getWorkspaceSnapshot(workspace.id)

    expect(snapshot.agents).toHaveLength(1)
    expect(snapshot.agents[0]).toMatchObject({
      name: 'Orchestrator',
      role: 'orchestrator',
      status: 'stopped',
      pendingTaskCount: 0,
    })
  })

  test('can add worker', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    expect(worker).toMatchObject({
      workspaceId: workspace.id,
      name: 'Alice',
      role: 'coder',
      status: 'stopped',
      pendingTaskCount: 0,
    })
  })

  test('dispatchTask increments worker pending count and marks it working', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // Simulate PTY started: worker is idle, not stopped (spec §3.6.4 keeps
    // stopped workers from being silently promoted to working when their
    // PTY isn't actually running).
    store.getWorker(workspace.id, worker.id).status = 'idle'

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(1)
    expect(updatedWorker.status).toBe('working')
  })

  test('dispatchTask keeps a stopped worker stopped while accumulating queue', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // worker.addWorker initialises status='stopped' (PTY hasn't started).

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(1)
    expect(updatedWorker.status).toBe('stopped')
  })

  test('startAgent success promotes a fresh worker from stopped to idle', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    store.configureAgentLaunch(workspace.id, worker.id, { command: '/bin/bash', args: [] })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    expect(store.getWorker(workspace.id, worker.id).status).toBe('idle')
  })

  test('startAgent resets a queued worker back to idle (status tracks activity, not backlog)', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // Worker was running, took a dispatch (pendingTaskCount=1, status='working'),
    // then user hit [Restart]. A fresh PTY hasn't done any work yet — the next
    // team send is what should flip status back to 'working', not the leftover
    // queue depth.
    store.getWorker(workspace.id, worker.id).status = 'idle'
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    store.configureAgentLaunch(workspace.id, worker.id, { command: '/bin/bash', args: [] })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.status).toBe('idle')
    // pendingTaskCount stays so WorkerModal / recovery summary can still surface
    // the backlog — the status field just doesn't read from it anymore.
    expect(updatedWorker.pendingTaskCount).toBe(1)
  })

  test('startAgent transitions a stopped worker with pending backlog to idle (restart path)', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // Simulate the hydration end-state after a hive restart: worker status is
    // 'stopped' (PTY isn't running), but dispatch ledger replay left
    // pendingTaskCount > 0 because the previous session ended before the
    // worker reported back. User hits [Restart] -> startAgent -> must NOT
    // auto-promote to 'working'.
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    expect(store.getWorker(workspace.id, worker.id).pendingTaskCount).toBe(1)
    expect(store.getWorker(workspace.id, worker.id).status).toBe('stopped')
    store.configureAgentLaunch(workspace.id, worker.id, { command: '/bin/bash', args: [] })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.status).toBe('idle')
    expect(updatedWorker.pendingTaskCount).toBe(1)
  })

  test('reportTask resets worker pending count and returns it to idle', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // Simulate PTY already running so dispatchTask can promote to working.
    store.getWorker(workspace.id, worker.id).status = 'idle'

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    store.reportTask(workspace.id, worker.id, { status: 'success', text: 'Done' })

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(0)
    expect(updatedWorker.status).toBe('idle')
  })

  test('reportTask keeps a stopped worker stopped while draining pending count', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    store.getWorker(workspace.id, worker.id).status = 'stopped'
    store.reportTask(workspace.id, worker.id, { status: 'success', text: 'Done' })

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(0)
    expect(updatedWorker.status).toBe('stopped')
  })

  test('listWorkers excludes orchestrator', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    store.addWorker(workspace.id, {
      name: 'Bob',
      role: 'tester',
    })

    expect(store.listWorkers(workspace.id)).toEqual([
      {
        id: expect.any(String),
        name: 'Alice',
        role: 'coder',
        status: 'stopped',
        pendingTaskCount: 0,
      },
      {
        id: expect.any(String),
        name: 'Bob',
        role: 'tester',
        status: 'stopped',
        pendingTaskCount: 0,
      },
    ])
  })

  test('rejects duplicate worker names within the same workspace', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    expect(() =>
      store.addWorker(workspace.id, {
        name: 'Alice',
        role: 'tester',
      })
    ).toThrow('Worker name already exists: Alice')
  })

  test('normalizes worker names on create before storing and matching duplicates', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')

    const worker = store.addWorker(workspace.id, {
      name: ' Alice ',
      role: 'coder',
    })

    expect(worker.name).toBe('Alice')
    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({ id: worker.id, name: 'Alice' })
    )
    expect(() =>
      store.addWorker(workspace.id, {
        name: 'Alice',
        role: 'tester',
      })
    ).toThrow('Worker name already exists: Alice')
  })

  test('rejects blank worker names on create', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')

    expect(() => store.addWorker(workspace.id, { name: '   ', role: 'coder' })).toThrow(
      'Worker name must not be empty'
    )
  })

  test('addWorker does not mutate memory when DB insert fails', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-add-worker-db-fail-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    const workspaceStore = createWorkspaceStore(db, [])
    const workspace = workspaceStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const originalPrepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((source: string) => {
      if (source.startsWith('INSERT INTO workers')) {
        throw new Error('insert worker failed')
      }
      return originalPrepare(source)
    })

    expect(() => workspaceStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })).toThrow(
      /insert worker failed/
    )
    expect(workspaceStore.listWorkers(workspace.id)).toEqual([])

    db.close()
  })
})
