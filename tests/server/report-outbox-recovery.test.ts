import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control sequences are the value under test.
const TERMINAL_OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control sequences are the value under test.
const TERMINAL_CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu

const stripTerminalControls = (value: string) =>
  value.replace(TERMINAL_OSC_SEQUENCE, '').replace(TERMINAL_CSI_SEQUENCE, '')

const normalizeTerminalText = (value: string) => stripTerminalControls(value).replace(/\r?\n/g, '')

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

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

describe('report outbox recovery', () => {
  test('replays a queued report when the restarted Orchestrator next lists its team', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-report-outbox-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const orchestratorScript = join(workspacePath, 'orchestrator-echo.js')
    writeFileSync(
      orchestratorScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => process.stdout.write('ORCH:' + chunk))",
      ].join('\n')
    )

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const [orchestrator] = store.getWorkspaceSnapshot(workspace.id).agents
    if (!orchestrator) throw new Error('Expected Orchestrator')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    await store.dispatchTask(workspace.id, worker.id, 'Implement login')
    expect(
      store.reportTask(workspace.id, worker.id, {
        requireActiveRun: true,
        text: 'Login implementation is complete',
      })
    ).toMatchObject({ deliveryState: 'queued', forwarded: false })

    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      args: [orchestratorScript],
      command: process.execPath,
    })
    await store.startAgent(workspace.id, orchestrator.id, { hivePort: '4010' })

    // The startup instructions direct an Orchestrator to call `team list`.
    // That poll is also the durable report replay trigger.
    store.listWorkers(workspace.id)

    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, orchestrator.id)
      const output = normalizeTerminalText(run?.output ?? '')
      expect(output).toContain('ORCH:')
      expect(output).toContain('Login implementation is complete')
    })
  })
})
