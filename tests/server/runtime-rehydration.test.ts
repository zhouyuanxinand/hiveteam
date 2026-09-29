import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import Database from '../../src/server/sqlite.js'
import { createAuthorizedTestRuntimeStore as createRuntimeStore } from '../helpers/authorized-runtime.js'
import { normalizePtyText } from '../helpers/platform-cli.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH
const originalClaudeProjectsDir = process.env.HIVE_CLAUDE_PROJECTS_DIR
const stores: Array<ReturnType<typeof createRuntimeStore>> = []
const SESSION_ID = '11111111-1111-4111-8111-111111111111'

const writeFakeClaudeCli = (binDir: string) => {
  const scriptPath = join(binDir, 'fake-claude.js')
  writeFileSync(
    scriptPath,
    [
      "const { mkdirSync, writeFileSync } = require('node:fs')",
      "const { join } = require('node:path')",
      'const root = process.env.HIVE_CLAUDE_PROJECTS_DIR',
      "if (!root) throw new Error('Missing synthetic Claude session directory')",
      "const encodedCwd = [...process.cwd()].map((char) => [32, 47, 58, 92].includes(char.charCodeAt(0)) ? '-' : char).join('')",
      'const directory = join(root, encodedCwd)',
      'mkdirSync(directory, { recursive: true })',
      "const marker = 'Hive session binding: workspace_id=' + process.env.HIVE_PROJECT_ID + '; agent_id=' + process.env.HIVE_AGENT_ID",
      `writeFileSync(join(directory, '${SESSION_ID}.jsonl'), JSON.stringify({ message: { content: marker, role: 'user' } }) + '\\n')`,
      "console.log('ARGS:' + JSON.stringify(process.argv.slice(2)))",
      "console.log('CWD:' + process.cwd())",
      'process.stdin.resume()',
    ].join('\n')
  )

  const unixCli = join(binDir, 'claude')
  writeFileSync(unixCli, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
  chmodSync(unixCli, 0o755)

  const winCli = join(binDir, 'claude.cmd')
  writeFileSync(winCli, `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`)
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close()
  }
  process.env.PATH = originalPath
  if (originalClaudeProjectsDir === undefined) delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  else process.env.HIVE_CLAUDE_PROJECTS_DIR = originalClaudeProjectsDir
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('runtime rehydration', () => {
  test('restores workers and pending task counts from sqlite state', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-runtime-'))
    tempDirs.push(dataDir)

    const firstStore = createRuntimeStore({ dataDir })
    stores.push(firstStore)
    const workspace = firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const alice = firstStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const bob = firstStore.addWorker(workspace.id, { name: 'Bob', role: 'tester' })

    firstStore.dispatchTask(workspace.id, alice.id, 'Implement login')
    firstStore.dispatchTask(workspace.id, bob.id, 'Write tests')
    firstStore.reportTask(workspace.id, bob.id)

    await firstStore.close()
    const secondStore = createRuntimeStore({ dataDir })
    stores.push(secondStore)

    expect(secondStore.listWorkers(workspace.id)).toEqual([
      {
        id: alice.id,
        name: 'Alice',
        role: 'coder',
        status: 'stopped',
        pendingTaskCount: 1,
      },
      {
        id: bob.id,
        name: 'Bob',
        role: 'tester',
        status: 'stopped',
        pendingTaskCount: 0,
      },
    ])
  })

  test('restores pending task counts from dispatches instead of legacy message replay', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-runtime-dispatch-pending-'))
    tempDirs.push(dataDir)

    const firstStore = createRuntimeStore({ dataDir })
    stores.push(firstStore)
    const workspace = firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const alice = firstStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    firstStore.dispatchTask(workspace.id, alice.id, 'First')
    firstStore.dispatchTask(workspace.id, alice.id, 'Second')
    firstStore.reportTask(workspace.id, alice.id)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.prepare(
      `INSERT INTO messages (
         workspace_id,
         worker_id,
         type,
         from_agent_id,
         to_agent_id,
         text,
         status,
         artifacts,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      workspace.id,
      alice.id,
      'report',
      alice.id,
      null,
      'legacy orphan report',
      null,
      '[]',
      Date.now()
    )
    db.close()

    await firstStore.close()
    const secondStore = createRuntimeStore({ dataDir })
    stores.push(secondStore)

    expect(secondStore.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({ id: alice.id, pendingTaskCount: 1, status: 'stopped' })
    )
  })

  test('drains a pending dispatch before closing its runtime database', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-runtime-close-dispatch-'))
    const workspacePath = join(dataDir, 'workspace')
    tempDirs.push(dataDir)
    mkdirSync(workspacePath, { recursive: true })

    const store = createRuntimeStore({ dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    // Do not await before closing: this mirrors a shutdown while the Git
    // baseline capture is still in flight.
    const pendingDispatch = store.dispatchTask(workspace.id, worker.id, 'Implement login')

    await store.close()
    await expect(pendingDispatch).resolves.toMatchObject({
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
  })

  test('captures Claude session id into sqlite and reuses it on next start', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-runtime-session-'))
    const workspacePath = join(dataDir, 'workspace')
    const claudeProjectsDir = join(dataDir, 'claude-projects')
    const binDir = join(dataDir, 'bin')
    tempDirs.push(dataDir)
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(claudeProjectsDir, { recursive: true })
    writeFakeClaudeCli(binDir)
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`

    const firstStore = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(firstStore)
    const workspace = firstStore.createWorkspace(realpathSync(workspacePath), 'Alpha')
    const worker = firstStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    firstStore.configureAgentLaunch(workspace.id, worker.id, {
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: {
        pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
        source: 'claude_project_jsonl_dir',
      },
    })

    process.env.HIVE_CLAUDE_PROJECTS_DIR = claudeProjectsDir
    const manager = createAgentManager()

    await firstStore.close()
    const secondStore = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(secondStore)
    const firstRun = await secondStore.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await vi.waitFor(
      () => expect(secondStore.getLiveRun(firstRun.runId).output).toContain('ARGS:'),
      { timeout: 10_000 }
    )
    await vi.waitFor(() => {
      const output = normalizePtyText(secondStore.getLiveRun(firstRun.runId).output)
      expect(output).toContain('ARGS:["--dangerously-skip-permissions"]')
      expect(output).toContain(`CWD:${workspace.path}`)
    })

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    try {
      await vi.waitFor(
        () => {
          expect(
            db
              .prepare(
                'SELECT last_session_id FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?'
              )
              .get(workspace.id, worker.id)
          ).toEqual({ last_session_id: SESSION_ID })
          expect(
            db
              .prepare('SELECT last_session_id FROM workers WHERE workspace_id = ? AND id = ?')
              .get(workspace.id, worker.id)
          ).toEqual({ last_session_id: SESSION_ID })
        },
        { timeout: 5000 }
      )
    } finally {
      db.close()
    }

    await secondStore.close()
    const thirdStore = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(thirdStore)
    const secondRun = await thirdStore.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await vi.waitFor(
      () => expect(thirdStore.getLiveRun(secondRun.runId).output).toContain('ARGS:'),
      { timeout: 10_000 }
    )
    await vi.waitFor(() => {
      const output = normalizePtyText(thirdStore.getLiveRun(secondRun.runId).output)
      expect(output).toContain(
        `ARGS:${JSON.stringify(['--resume', SESSION_ID, '--dangerously-skip-permissions'])}`
      )
      expect(output).toContain(`CWD:${workspace.path}`)
    })
  })
})
