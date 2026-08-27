import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { normalizePtyText, writeNodeCli } from '../helpers/platform-cli.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 3000,
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
  delete process.env.HIVE_DATA_DIR
  process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('agent startup instructions', () => {
  test('only a new orchestrator run receives startup guidance; an idle worker stays at its CLI prompt', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-agent-startup-instructions-'))
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
        'let submitReadyAt = 0',
        "process.stdout.write('❯ ')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('IN:' + chunk)",
        "  if (chunk.includes('\\u001b[201~')) {",
        "    process.stdout.write('\\n[Pasted text #1 +1 lines]\\n')",
        '    submitReadyAt = Date.now() + 500',
        '  }',
        "  const isSubmit = submitReadyAt > 0 && (chunk === '\\r' || chunk === '\\n' || chunk === '\\r\\n')",
        "  if (isSubmit && Date.now() >= submitReadyAt) process.stdout.write('\\nSUBMITTED\\n❯ ')",
        "  else if (isSubmit) process.stdout.write('\\nEARLY_ENTER_IGNORED\\n❯ ')",
        '})',
        'process.stdin.resume()',
      ].join('\n')
    )

    process.env.HIVE_DATA_DIR = dataDir
    const pathDelimiter = process.platform === 'win32' ? ';' : ':'
    process.env.PATH = `${binDir}${pathDelimiter}${originalPath ?? ''}`
    const hive = await runHiveCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Alpha',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart: false, name: 'Alice', role: 'coder' }),
      })
      expect(workerResponse.status).toBe(201)
      const worker = (await workerResponse.json()) as { id: string }

      const configure = async (agentId: string) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify({
              command: 'claude',
              args: [],
            }),
          }
        )
        expect(response.status).toBe(204)
      }
      const start = async (agentId: string) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify({ hive_port: String(hive.port) }),
          }
        )
        expect(response.status).toBe(201)
        const payload = (await response.json()) as { run_id: string }
        return { runId: payload.run_id }
      }

      await configure(orchestratorId)
      await configure(worker.id)
      const orchestratorRun = await start(orchestratorId)
      const workerRun = await start(worker.id)

      await waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/runtime/runs/${orchestratorRun.runId}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await response.json()) as { output: string }
        const output = normalizePtyText(body.output).replaceAll('IN:', '')
        expect(output).toContain('[Hive 系统消息：启动说明]')
        expect(output).toContain('你是 Alpha 的 Orchestrator')
        expect(output).toContain('team send <worker-name> "<task>"')
        expect(output).toContain('team cancel --dispatch <id> "<reason>"')
        expect(output).toContain('team list')
        expect(output).toContain('维护 .hive/tasks.md')
        expect(output).toContain('Hive worker 是右侧卡片里的真实 CLI agent')
        expect(output).toContain('先执行 `team list` 确认真实 Hive worker')
        expect(output).toContain('普通、低风险、几分钟内能直接完成的小任务可以自己做')
        expect(output).toContain('或 user 明确要求 worker/成员处理时，再用 `team send`')
        expect(output).toContain('如果只有一个可用 worker，直接用 `team send <worker-name>')
        expect(output).toContain('不要使用你所在 CLI 的内置 subagent / 子代理工具')
        expect(output).not.toContain('team report')
        expect(output).toContain('SUBMITTED')
      }, 6000)

      await waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/runtime/runs/${workerRun.runId}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await response.json()) as { output: string }
        const output = normalizePtyText(body.output).replaceAll('IN:', '')
        // Windows console rendering can trim the prompt's trailing space.
        expect(output).toContain('❯')
        expect(output).not.toContain('[Hive 系统消息：启动说明]')
        expect(output).not.toContain('你是 Alpha 的 Alice（coder）')
        expect(output).not.toContain('SUBMITTED')
      }, 6000)
    } finally {
      await hive.close()
    }
  })
})
