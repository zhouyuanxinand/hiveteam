import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import type { RuntimeStore } from '../../src/server/runtime-store.js'
import { createAuthorizedTestRuntimeStore as createRuntimeStore } from '../helpers/authorized-runtime.js'

let directory: string
const stores: RuntimeStore[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hive-start-agent-rollback-'))
})

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('startAgent exception rollback (R1.2)', () => {
  test('marks agent stopped when launch config is missing', async () => {
    const store = createRuntimeStore()
    stores.push(store)
    const workspace = store.createWorkspace(directory, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    await expect(store.startAgent(workspace.id, worker.id, { hivePort: '4010' })).rejects.toThrow(
      /Agent launch config not found/
    )

    expect(store.getWorker(workspace.id, worker.id).status).toBe('stopped')
  })

  test('worker lands in stopped (§12) when the spawned command does not exist', async () => {
    const store = createRuntimeStore({ agentManager: createAgentManager() })
    stores.push(store)
    const workspace = store.createWorkspace(directory, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: '/definitely/not/a/real/binary',
      args: [],
    })

    await expect(store.startAgent(workspace.id, worker.id, { hivePort: '4010' })).rejects.toThrow(
      '/definitely/not/a/real/binary CLI not found in PATH'
    )

    expect(store.getWorker(workspace.id, worker.id).status).toBe('stopped')
    expect(store.peekAgentToken(worker.id)).toBeUndefined()
    expect(store.listAgentRuns(worker.id)).toEqual([])
  })

  test('marks agent stopped when agentManager.startAgent throws after token issue', async () => {
    const agentManager = createAgentManager()
    const spawnError = new Error('simulated spawn failure')
    vi.spyOn(agentManager, 'startAgent').mockRejectedValue(spawnError)

    const store = createRuntimeStore({ agentManager })
    stores.push(store)
    const workspace = store.createWorkspace(directory, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, { command: process.execPath, args: [] })

    await expect(store.startAgent(workspace.id, worker.id, { hivePort: '4010' })).rejects.toThrow(
      /simulated spawn failure/
    )

    expect(store.getWorker(workspace.id, worker.id).status).toBe('stopped')
    // Token must not linger after a failed start.
    expect(store.peekAgentToken(worker.id)).toBeUndefined()
  })
})
