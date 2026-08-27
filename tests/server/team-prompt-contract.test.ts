import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
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
    store.memory.create(workspace.id, {
      body: '实现登录必须保留现有 session cookie 兼容性。',
      kind: 'decision',
      tags: ['auth'],
    })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [workerScript],
    })

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
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
    })
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
    }, 4000)

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
    }, 4000)

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
      expect(output.match(/SUBMITTED/g)?.length ?? 0).toBeGreaterThanOrEqual(
        process.platform === 'win32' ? 1 : 2
      )
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
      expect(output.match(/SUBMITTED/g)?.length ?? 0).toBeGreaterThanOrEqual(
        process.platform === 'win32' ? 1 : 2
      )
    }, 4000)
  })
})
