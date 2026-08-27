import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { runTeamCommand } from '../../src/cli/team.js'
import { getUiCookie } from '../helpers/ui-session.js'

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control sequences are the value under test.
const TERMINAL_OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control sequences are the value under test.
const TERMINAL_CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu

const stripTerminalControls = (value: string) =>
  value.replace(TERMINAL_OSC_SEQUENCE, '').replace(TERMINAL_CSI_SEQUENCE, '')

const normalizeTerminalText = (value: string) => stripTerminalControls(value).replace(/\r?\n/g, '')

const compactTerminalText = (value: string) => stripTerminalControls(value).replace(/\s/g, '')

const runTeamBinaryWithStdin = (
  args: string[],
  env: Record<string, string>,
  stdinContent: string
): Promise<{ code: number | null; stderr: string; stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'bin/team', ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const resolveOnce = (code: number | null) => {
      if (settled) return
      settled = true
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    }

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => rejectOnce(error))
    child.stdin.on('error', (error) => {
      // A short-lived CLI can exit before Windows finishes flushing the
      // inherited stdin pipe (notably for invalid-argument tests). This is
      // a normal child-process race; the exit code and stderr remain useful.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPIPE' && code !== 'EOF') rejectOnce(error)
    })
    child.on('close', (code) => resolveOnce(code))
    child.stdin.end(stdinContent)
  })

const tempDirs: string[] = []
const originalEnv = { ...process.env }

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 2000,
  intervalMs = 25
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

afterEach(() => {
  process.env = { ...originalEnv }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('team report cli', () => {
  test('team status without a dispatch forwards and records a status update', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-status-report-cli-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const orchScript = join(workspacePath, 'orch-echo.js')
    writeFileSync(
      orchScript,
      "process.stdin.setEncoding('utf8')\nprocess.stdin.on('data', c => process.stdout.write('ORCH:' + c))\n"
    )

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])
    let hiveClosed = false
    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`
      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }

      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          command: process.execPath,
          args: [orchScript],
        }),
      })
      const startResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ hive_port: String(hive.port) }),
        }
      )
      const payload = (await startResponse.json()) as { run_id: string }

      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          command: process.execPath,
          args: ['-e', 'process.stdin.resume()'],
        }),
      })
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })

      process.env = {
        ...originalEnv,
        HIVE_DATA_DIR: dataDir,
        HIVE_AGENT_ID: worker.id,
        HIVE_AGENT_TOKEN: hive.store.peekAgentToken(worker.id) ?? '',
        HIVE_PORT: String(hive.port),
        HIVE_PROJECT_ID: workspace.id,
      }
      await runTeamCommand(['status', 'Alice 已接入 workspace，等待派单'])

      await waitFor(async () => {
        const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${payload.run_id}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await runResponse.json()) as { output: string }
        const output = normalizeTerminalText(body.output)
        expect(output).toContain('[Hive 系统消息：来自 @Alice 的状态更新]')
        expect(output).toContain('Alice 已接入 workspace，等待派单')
      })
      expect(hive.store.listDispatches(workspace.id)).toEqual([])
      expect(hive.store.listMessagesForRecovery(workspace.id, 0)).toContainEqual(
        expect.objectContaining({
          from: worker.id,
          text: 'Alice 已接入 workspace，等待派单',
          type: 'status',
        })
      )
      await hive.close()
      hiveClosed = true
      const reopenedHive = await runHiveCommand(['--port', '0'])
      try {
        expect(reopenedHive.store.listMessagesForRecovery(workspace.id, 0)).toContainEqual(
          expect.objectContaining({
            from: worker.id,
            text: 'Alice 已接入 workspace，等待派单',
            type: 'status',
          })
        )
      } finally {
        await reopenedHive.close()
      }
    } finally {
      delete process.env.HIVE_DATA_DIR
      if (!hiveClosed) await hive.close()
    }
  })

  test('team report writes through to orchestrator stdin and records message', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-report-cli-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const orchScript = join(workspacePath, 'orch-echo.js')
    writeFileSync(
      orchScript,
      "process.stdin.setEncoding('utf8')\nprocess.stdin.on('data', c => process.stdout.write('ORCH:' + c))\n"
    )

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`
      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }

      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          command: process.execPath,
          args: [orchScript],
        }),
      })
      const startResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ hive_port: String(hive.port) }),
        }
      )
      const payload = (await startResponse.json()) as { run_id: string }
      const run = { runId: payload.run_id }

      const workerConfig = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({
            command: process.execPath,
            args: ['-e', 'process.stdin.resume()'],
          }),
        }
      )
      if (workerConfig.status !== 204) {
        throw new Error(`Failed to configure worker: ${await workerConfig.text()}`)
      }
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })

      const workerToken = hive.store.peekAgentToken(worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }
      const orchestratorToken = hive.store.peekAgentToken(orchestratorId)
      if (!orchestratorToken) {
        throw new Error('Expected orchestrator token after start')
      }
      process.env = {
        ...originalEnv,
        HIVE_DATA_DIR: dataDir,
        HIVE_AGENT_ID: orchestratorId,
        HIVE_AGENT_TOKEN: orchestratorToken,
        HIVE_PORT: String(hive.port),
        HIVE_PROJECT_ID: workspace.id,
      }
      await runTeamCommand(['send', 'Alice', 'Report this CLI task'])
      process.env = {
        ...originalEnv,
        HIVE_DATA_DIR: dataDir,
        HIVE_AGENT_ID: worker.id,
        HIVE_AGENT_TOKEN: workerToken,
        HIVE_PORT: String(hive.port),
        HIVE_PROJECT_ID: workspace.id,
      }
      await runTeamCommand(['report', 'Done via CLI', '--artifact', 'src/auth.ts'])

      await waitFor(async () => {
        const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${run.runId}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await runResponse.json()) as { output: string }
        expect(body.output).toContain('Done via CLI')
        expect(body.output).toContain('src/auth.ts')
        expect(body.output).not.toContain('状态:')
        expect(body.output).not.toContain('success')
      })
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  })

  test('team report --stdin pipes a multi-line body through to orchestrator stdin', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-report-stdin-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const orchScript = join(workspacePath, 'orch-echo.js')
    writeFileSync(
      orchScript,
      "process.stdin.setEncoding('utf8')\nprocess.stdin.on('data', c => process.stdout.write('ORCH:' + c))\n"
    )

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`
      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }

      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          command: process.execPath,
          args: [orchScript],
        }),
      })
      const startResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ hive_port: String(hive.port) }),
        }
      )
      const orchStart = (await startResponse.json()) as { run_id: string }

      const workerConfig = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({
            command: process.execPath,
            args: ['-e', 'process.stdin.resume()'],
          }),
        }
      )
      if (workerConfig.status !== 204) {
        throw new Error(`Failed to configure worker: ${await workerConfig.text()}`)
      }
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })

      const workerToken = hive.store.peekAgentToken(worker.id)
      if (!workerToken) throw new Error('Expected worker token after start')
      const orchestratorToken = hive.store.peekAgentToken(orchestratorId)
      if (!orchestratorToken) throw new Error('Expected orchestrator token after start')

      process.env = {
        ...originalEnv,
        HIVE_DATA_DIR: dataDir,
        HIVE_AGENT_ID: orchestratorId,
        HIVE_AGENT_TOKEN: orchestratorToken,
        HIVE_PORT: String(hive.port),
        HIVE_PROJECT_ID: workspace.id,
      }
      await runTeamCommand(['send', 'Alice', 'Pipe a long report back'])

      const multilineReport = [
        '## Bug fix summary',
        '',
        'Fixed the issue where `team report` lost results when',
        'the body contained "quotes" and special chars like $RUNTIME_VAR.',
        '',
        'Files touched:',
        '- src/cli/team.ts',
        '- tests/unit/team-cli-parse-args.test.ts',
      ].join('\n')

      const result = await runTeamBinaryWithStdin(
        ['report', '--stdin'],
        {
          HIVE_DATA_DIR: dataDir,
          HIVE_AGENT_ID: worker.id,
          HIVE_AGENT_TOKEN: workerToken,
          HIVE_PORT: String(hive.port),
          HIVE_PROJECT_ID: workspace.id,
        },
        multilineReport
      )
      if (result.code !== 0) {
        throw new Error(
          `team report --stdin exited ${result.code}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`
        )
      }

      await waitFor(async () => {
        const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${orchStart.run_id}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await runResponse.json()) as { output: string }
        const output = compactTerminalText(body.output)
        expect(output).toContain('##Bugfixsummary')
        expect(output).toContain('lostresultswhen')
        expect(output).toContain('"quotes"andspecialcharslike$RUNTIME_VAR')
        expect(output).toContain('-src/cli/team.ts')
      })

      expect(hive.store.listMessagesForRecovery(workspace.id, 0)).toContainEqual(
        expect.objectContaining({
          from: worker.id,
          text: expect.stringContaining('## Bug fix summary'),
          type: 'report',
        })
      )
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  })

  test('team report --stdin rejects piped input combined with a positional', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-report-stdin-conflict-'))
    tempDirs.push(dataDir)

    const result = await runTeamBinaryWithStdin(
      ['report', '--stdin', 'positional-result'],
      {
        HIVE_DATA_DIR: dataDir,
        HIVE_AGENT_ID: 'unused',
        HIVE_AGENT_TOKEN: 'unused',
        HIVE_PORT: '1',
        HIVE_PROJECT_ID: 'unused',
      },
      'piped'
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--stdin is mutually exclusive with a positional argument')
    expect(result.stderr).toContain('Usage:')
  })
})
