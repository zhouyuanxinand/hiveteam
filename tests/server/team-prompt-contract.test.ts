import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import Database from '../../src/server/sqlite.js'
import { setWorkspaceMemoryEnabled } from '../../src/server/team-memory-digest.js'
import { createAuthorizedTestRuntimeStore as createRuntimeStore } from '../helpers/authorized-runtime.js'
import { writeNodeCli } from '../helpers/platform-cli.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

// biome-ignore lint/suspicious/noControlCharactersInRegex: PTY output intentionally contains ANSI OSC control sequences.
const ANSI_OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
// Keep bracketed-paste start/end markers so the interactive CLI contract can assert them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: PTY output intentionally contains ANSI CSI control sequences.
const ANSI_CSI_SEQUENCE_EXCEPT_BRACKETED_PASTE = /\u001b\[(?!200~|201~)[0-?]*[ -/]*[@-~]/g

const stripTerminalControls = (value: string) =>
  value.replace(ANSI_OSC_SEQUENCE, '').replace(ANSI_CSI_SEQUENCE_EXCEPT_BRACKETED_PASTE, '')

const normalizePtyOutput = (value: string) =>
  stripTerminalControls(value).replace(/[\r\n\t ]+/g, ' ')

const waitFor = async (assertion: () => void, timeoutMs = 2000, intervalMs = 25) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

afterEach(async () => {
  process.env.PATH = originalPath
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('team prompt contract', () => {
  test('team send injects sender display name, role description, and task text', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-prompt-contract-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const workerScript = join(workspacePath, 'worker-echo.js')
    writeFileSync(
      workerScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => process.stdout.write(chunk))",
        "process.stdout.write('WORKER_READY\\n')",
      ].join('\n')
    )

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const memory = store.memory.create(workspace.id, {
      body: '实现登录必须保留现有 session cookie 兼容性。',
      kind: 'decision',
      tags: ['auth'],
    })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [workerScript],
    })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    // ConPTY capability negotiation precedes the fixture's native startup.
    // Keep that phase separate from the prompt delivery deadline below.
    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, worker.id)
      expect(run?.output).toContain('WORKER_READY')
    }, 10_000)
    const dispatch = await store.dispatchTaskByWorkerName(workspace.id, 'Alice', '实现登录', {
      fromAgentId: orchestrator.id,
    })

    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, worker.id)
      const output = stripTerminalControls(run?.output.replace(/\r\n/g, '\n') ?? '')
      expect(output).toContain('@Orchestrator')
      expect(output.replace(/\s/g, '')).toContain(
        `你的角色：${worker.description}`.replace(/\s/g, '')
      )
      const compactOutput = output.replace(/\s/g, '')
      expect(compactOutput).toContain(
        `执行\`teamreport"<result>"--dispatch${dispatch.id}\``.replace(/\s/g, '')
      )
      expect(compactOutput).toContain(`dispatch_id:${dispatch.id}`)
      expect(output).not.toContain('--success')
      expect(output).not.toContain('--failed')
      expect(output).toContain('实现登录')
      expect(compactOutput).toContain('<hive-memorycontext="dispatch">')
      expect(compactOutput).toContain('必须保留现有sessioncookie兼容性')
      // Task body is followed by a <hive-system-reminder> tail carrying the
      // dispatch_id-bound report syntax — this is what re-anchors the worker
      // identity after an internal /compact.
      expect(compactOutput).toMatch(
        /实现登录[\s\S]*<hive-system-reminder>[\s\S]*<\/hive-system-reminder>/
      )
      expect(compactOutput).toContain(`teamreport"<result>"--dispatch${dispatch.id}`)
      const snapshot = store.memory.contexts(workspace.id, dispatch.id)[0]
      expect(snapshot).toMatchObject({
        dispatch_id: dispatch.id,
        agent_id: worker.id,
        candidates: [expect.objectContaining({ memory_id: memory.id, selected: true })],
      })
      expect(compactOutput).toContain(snapshot?.digest.replace(/\s/g, ''))
    })
    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    try {
      expect(
        db
          .prepare(
            'SELECT memory_id,dispatch_id,target_agent_id_snapshot FROM memory_injections WHERE context_type=? AND dispatch_id=?'
          )
          .all('dispatch', dispatch.id)
      ).toEqual([
        { memory_id: memory.id, dispatch_id: dispatch.id, target_agent_id_snapshot: worker.id },
      ])
    } finally {
      db.close()
    }
  })

  test.each([
    'disabled',
    'candidate-only',
  ] as const)('real PTY receives the task without memory when %s', async (mode) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-no-memory-prompt-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath)
    tempDirs.push(dataDir)
    const script = join(workspacePath, 'echo.cjs')
    writeFileSync(
      script,
      "process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => process.stdout.write(chunk)); process.stdout.write('WORKER_READY\\n')"
    )
    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Memory switches')
    const worker = store.addWorker(workspace.id, { name: 'Memory checker', role: 'coder' })
    store.memory.create(workspace.id, {
      kind: 'fact',
      body: 'MEMORY_MUST_STAY_EXCLUDED',
      status: mode === 'candidate-only' ? 'candidate' : 'active',
    })
    if (mode === 'disabled') setWorkspaceMemoryEnabled(store.settings, workspace.id, false)
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [script],
    })
    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await waitFor(
      () =>
        expect(store.getActiveRunByAgentId(workspace.id, worker.id)?.output).toContain(
          'WORKER_READY'
        ),
      10000
    )
    const dispatch = await store.dispatchTask(workspace.id, worker.id, 'TASK_WITHOUT_MEMORY')
    await waitFor(() => {
      const output = stripTerminalControls(
        store.getActiveRunByAgentId(workspace.id, worker.id)?.output ?? ''
      ).replace(/\s/g, '')
      expect(output).toContain(`dispatch_id:${dispatch.id}`)
      expect(output).toContain('TASK_WITHOUT_MEMORY')
      expect(output).not.toContain('MEMORY_MUST_STAY_EXCLUDED')
      expect(output).not.toContain('<hive-memory')
    })
    const contexts = store.memory.contexts(workspace.id, dispatch.id)
    if (mode === 'disabled') expect(contexts).toEqual([])
    else
      expect(contexts).toEqual([
        expect.objectContaining({
          digest: '',
          used_chars: 0,
          candidates: [expect.objectContaining({ selected: false })],
        }),
      ])
    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    try {
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM memory_injections WHERE dispatch_id=?')
          .get(dispatch.id)
      ).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  test('team send submits prompts to interactive CLI agents after bracketed paste', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-interactive-team-send-'))
    const workspacePath = join(dataDir, 'workspace')
    const binDir = join(dataDir, 'bin')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    tempDirs.push(dataDir)

    writeNodeCli(
      binDir,
      'claude',
      [
        '#!/usr/bin/env node',
        "process.stdin.setEncoding('utf8')",
        'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
        'const SUBMIT_READY_DELAY_MS = 150',
        "const PASTE_END = '\\u001b[201~'",
        'let submitReadyAt = 0',
        "process.stdout.write('❯ ')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('IN:' + chunk)",
        '  if (chunk.includes(PASTE_END)) {',
        '    process.stdout.write("\\n[Pasted text #1 +1 lines]\\n")',
        '    submitReadyAt = Date.now() + SUBMIT_READY_DELAY_MS',
        '  }',
        "  const isSubmit = submitReadyAt > 0 && (chunk === '\\r' || chunk === '\\n' || chunk === '\\r\\n')",
        '  if (isSubmit) {',
        "    if (Date.now() >= submitReadyAt) process.stdout.write('\\nSUBMITTED\\n❯ ')",
        "    else process.stdout.write('\\nEARLY_ENTER_IGNORED\\n❯ ')",
        '  }',
        '})',
        'process.stdin.resume()',
      ].join('\n')
    )
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.memory.create(workspace.id, {
      body: 'All authentication changes must preserve backwards compatibility.',
      kind: 'decision',
      tags: ['auth'],
    })
    store.configureAgentLaunch(workspace.id, worker.id, { command: 'claude', args: [] })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, worker.id)
      expect(run?.output).toContain('❯')
      expect(run?.output).not.toContain('[Hive 系统消息：启动说明]')
      expect(run?.output).not.toContain('SUBMITTED')
    }, 10_000)

    await store.dispatchTaskByWorkerName(workspace.id, 'Alice', '实现登录', {
      fromAgentId: orchestrator.id,
    })

    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, worker.id)
      const output = normalizePtyOutput(run?.output ?? '')
      if (process.platform !== 'win32') expect(output).toContain('\u001b[200~')
      expect(output).toContain('[Hive 系统消息：来自 @Orchestrator 的派单]')
      expect(output).toContain('实现登录')
      if (process.platform !== 'win32') expect(output).toContain('\u001b[201~')
      expect(output.match(/SUBMITTED/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
    })
  })

  test('team send submits to a shell-wrapped Claude worker startup command using the selected CLI driver', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-shell-wrapped-claude-send-'))
    const workspacePath = join(dataDir, 'workspace')
    const binDir = join(dataDir, 'bin')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    tempDirs.push(dataDir)

    const fakeShell = writeNodeCli(
      binDir,
      'fake-zsh',
      [
        '#!/usr/bin/env node',
        "process.stdin.setEncoding('utf8')",
        'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
        "const PASTE_END = '\\u001b[201~'",
        'let submitReadyAt = 0',
        "process.stdout.write('❯ ')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('IN:' + chunk)",
        '  if (chunk.includes(PASTE_END)) {',
        '    process.stdout.write("\\n[Pasted text #1 +1 lines]\\n")',
        '    submitReadyAt = Date.now() + 150',
        '  }',
        "  const isSubmit = submitReadyAt > 0 && (chunk === '\\r' || chunk === '\\n' || chunk === '\\r\\n')",
        '  if (isSubmit) {',
        "    if (Date.now() >= submitReadyAt) process.stdout.write('\\nSUBMITTED\\n❯ ')",
        "    else process.stdout.write('\\nEARLY_ENTER_IGNORED\\n❯ ')",
        '  }',
        '})',
        'process.stdin.resume()',
      ].join('\n')
    )

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      args: ['-lic', 'ccs --continue'],
      command: fakeShell,
      interactiveCommand: 'claude',
      presetAugmentationDisabled: true,
    })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, worker.id)
      expect(run?.output).toContain('❯')
      expect(run?.output).not.toContain('[Hive 系统消息：启动说明]')
      expect(run?.output).not.toContain('SUBMITTED')
    }, 10_000)

    await store.dispatchTaskByWorkerName(workspace.id, 'Alice', '实现登录', {
      fromAgentId: orchestrator.id,
    })

    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, worker.id)
      const output = normalizePtyOutput(run?.output ?? '')
      if (process.platform !== 'win32') expect(output).toContain('\u001b[200~')
      expect(output).toContain('[Hive 系统消息：来自 @Orchestrator 的派单]')
      expect(output).toContain('实现登录')
      if (process.platform !== 'win32') expect(output).toContain('\u001b[201~')
      // The selected interactive CLI must receive one final submit for the
      // dispatched task. The wrapper command itself is a process argument,
      // not an additional prompt submission.
      expect(output.match(/SUBMITTED/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
    }, 4000)
  })

  test('team report submits to a shell-wrapped Claude startup command using the selected CLI driver', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-shell-wrapped-claude-report-'))
    const workspacePath = join(dataDir, 'workspace')
    const binDir = join(dataDir, 'bin')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    tempDirs.push(dataDir)

    const fakeShell = writeNodeCli(
      binDir,
      'fake-zsh',
      [
        '#!/usr/bin/env node',
        "process.stdin.setEncoding('utf8')",
        'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
        "const PASTE_END = '\\u001b[201~'",
        'let submitReadyAt = 0',
        "process.stdout.write('❯ ')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('IN:' + chunk)",
        '  if (chunk.includes(PASTE_END)) {',
        '    process.stdout.write("\\n[Pasted text #1 +1 lines]\\n")',
        '    submitReadyAt = Date.now() + 150',
        '  }',
        "  const isSubmit = submitReadyAt > 0 && (chunk === '\\r' || chunk === '\\n' || chunk === '\\r\\n')",
        '  if (isSubmit) {',
        "    if (Date.now() >= submitReadyAt) process.stdout.write('\\nSUBMITTED\\n❯ ')",
        "    else process.stdout.write('\\nEARLY_ENTER_IGNORED\\n❯ ')",
        '  }',
        '})',
        'process.stdin.resume()',
      ].join('\n')
    )

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }
    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      args: ['-lic', 'ccs --continue'],
      command: fakeShell,
      interactiveCommand: 'claude',
      presetAugmentationDisabled: true,
    })

    await store.startAgent(workspace.id, orchestrator.id, { hivePort: '4010' })
    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, orchestrator.id)
      expect(run?.output).toContain('❯')
    }, 10_000)
    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, orchestrator.id)
      expect(run?.output).toContain('[Hive 系统消息：启动说明]')
      expect(run?.output).toContain('SUBMITTED')
    }, 4000)

    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    })
    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await store.dispatchTaskByWorkerName(workspace.id, 'Alice', 'Report through shell wrapper', {
      fromAgentId: orchestrator.id,
    })
    store.reportTask(workspace.id, worker.id, {
      requireActiveRun: true,
      text: 'Done from shell-wrapped Claude',
    })

    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, orchestrator.id)
      const output = normalizePtyOutput(run?.output ?? '')
      if (process.platform !== 'win32') expect(output).toContain('\u001b[200~')
      expect(output).toContain('[Hive 系统消息：来自 @Alice 的汇报]')
      expect(output).toContain('Done from shell-wrapped Claude')
      if (process.platform !== 'win32') expect(output).toContain('\u001b[201~')
      expect(output.match(/SUBMITTED/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
    }, 4000)
  })
})
