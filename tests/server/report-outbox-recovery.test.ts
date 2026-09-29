import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import Database from '../../src/server/sqlite.js'
import { createAuthorizedTestRuntimeStore as createRuntimeStore } from '../helpers/authorized-runtime.js'

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
  test('checkpoints an in-flight report before closing its runtime database', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-report-outbox-close-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const orchestratorScript = join(workspacePath, 'orchestrator-prompt.js')
    writeFileSync(
      orchestratorScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdout.write('❯ ')",
        "process.stdin.on('data', (chunk) => {",
        "  if (chunk.includes('\\u001b[201~')) process.stdout.write('[Pasted text #1 +1 lines]')",
        '})',
        'process.stdin.resume()',
      ].join('\n')
    )

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const [orchestrator] = store.getWorkspaceSnapshot(workspace.id).agents
    if (!orchestrator) throw new Error('Expected Orchestrator')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      args: [orchestratorScript],
      command: process.execPath,
      interactiveCommand: 'claude',
    })
    await store.startAgent(workspace.id, orchestrator.id, { hivePort: '4010' })
    // Wait for native startup, including ConPTY capability negotiation, before
    // exercising the in-flight report checkpoint and shutdown boundary.
    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, orchestrator.id)
      expect(run?.output).toContain('❯')
    }, 10_000)

    await store.dispatchTask(workspace.id, worker.id, 'Implement login')
    expect(
      store.reportTask(workspace.id, worker.id, {
        requireActiveRun: true,
        text: 'Login implementation is complete',
      })
    ).toMatchObject({ deliveryState: 'delivering' })

    await store.close()

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    try {
      const entry = db
        .prepare('SELECT delivered_at FROM report_outbox WHERE workspace_id = ?')
        .get(workspace.id) as { delivered_at: number | null } | undefined
      expect(entry?.delivered_at).toBeNull()
      const delivery = db
        .prepare("SELECT state,write_started FROM message_deliveries WHERE kind='report'")
        .get() as { state: string; write_started: number }
      expect(delivery.state).toBe(delivery.write_started ? 'unknown' : 'pending')
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM message_deliveries WHERE state='attempting'")
          .get()
      ).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  test('replays a queued report after the Orchestrator starts without a team-list poll', async () => {
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
        "process.stdout.write('ORCH_READY\\n')",
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

    // The report remains queued before startup; observe native readiness before
    // applying the original replay deadline, without a team-list poll.
    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, orchestrator.id)
      expect(run?.output).toContain('ORCH_READY')
    }, 10_000)
    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, orchestrator.id)
      const output = normalizeTerminalText(run?.output ?? '')
      expect(output).toContain('ORCH:')
      expect(output).toContain('Login implementation is complete')
    })
  })
})
