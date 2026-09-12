import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { runTeamCommand } from '../../src/cli/team.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalEnv = { ...process.env }

const expectOk = async (response: Response, operation: string) => {
  if (!response.ok) {
    throw new Error(`${operation} failed (${response.status}): ${await response.text()}`)
  }
  return response
}

const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

describe('team Skill CLI integration', () => {
  test(
    'lists, loads, dispatches, and reads a pinned Skill through a live Hive runtime',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-skill-cli-'))
      tempDirs.push(dataDir)
      const workspacePath = join(dataDir, 'workspace')
      const sourcePath = join(dataDir, 'source-pack')
      const skillPath = join(sourcePath, 'skills', 'tdd')
      mkdirSync(join(skillPath, 'references'), { recursive: true })
      mkdirSync(workspacePath, { recursive: true })
      writeFileSync(
        join(skillPath, 'SKILL.md'),
        '---\nname: tdd\ndescription: Test-driven development.\n---\nPINNED CLI TDD INSTRUCTIONS'
      )
      writeFileSync(join(skillPath, 'references', 'guide.md'), 'CLI reference evidence')
      const echoScript = join(workspacePath, 'agent-echo.js')
      writeFileSync(
        echoScript,
        "process.stdin.setEncoding('utf8')\nprocess.stdin.on('data', chunk => process.stdout.write(chunk))\n"
      )

      process.env.HIVE_DATA_DIR = dataDir
      const hive = await runHiveCommand(['--port', '0'])
      try {
        const baseUrl = `http://127.0.0.1:${hive.port}`
        const cookie = await getUiCookie(baseUrl)
        const jsonHeaders = { 'content-type': 'application/json', cookie }
        const workspaceResponse = await expectOk(
          await fetch(`${baseUrl}/api/workspaces`, {
            body: JSON.stringify({
              autostart_orchestrator: false,
              name: 'Skill CLI',
              path: workspacePath,
            }),
            headers: jsonHeaders,
            method: 'POST',
          }),
          'create workspace'
        )
        const workspace = (await workspaceResponse.json()) as { id: string }
        const orchestratorId = `${workspace.id}:orchestrator`
        const workerResponse = await expectOk(
          await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
            body: JSON.stringify({ name: 'Alice', role: 'coder' }),
            headers: jsonHeaders,
            method: 'POST',
          }),
          'create worker'
        )
        const worker = (await workerResponse.json()) as { id: string }

        const releaseResponse = await expectOk(
          await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/resolve`, {
            body: JSON.stringify({
              name: 'matt',
              source: { path: sourcePath, type: 'local' },
            }),
            headers: jsonHeaders,
            method: 'POST',
          }),
          'resolve Pack'
        )
        const release = (await releaseResponse.json()) as { id: string }
        const planResponse = await expectOk(
          await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/plans`, {
            body: JSON.stringify({
              action: 'bind',
              native_exposure: [],
              pack_name: 'matt',
              profiles: { coder: ['tdd'], orchestrator: ['tdd'] },
              release_id: release.id,
            }),
            headers: jsonHeaders,
            method: 'POST',
          }),
          'plan Pack bind'
        )
        const plan = (await planResponse.json()) as { id: string }
        await expectOk(
          await fetch(
            `${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/plans/${plan.id}/apply`,
            { headers: { cookie }, method: 'POST' }
          ),
          'apply Pack bind'
        )

        for (const agentId of [orchestratorId, worker.id]) {
          await expectOk(
            await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`, {
              body: JSON.stringify({ args: [echoScript], command: process.execPath }),
              headers: jsonHeaders,
              method: 'POST',
            }),
            `configure ${agentId}`
          )
          await expectOk(
            await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`, {
              body: JSON.stringify({ hive_port: String(hive.port) }),
              headers: jsonHeaders,
              method: 'POST',
            }),
            `start ${agentId}`
          )
        }

        const orchestratorToken = hive.store.peekAgentToken(orchestratorId)
        const workerToken = hive.store.peekAgentToken(worker.id)
        if (!orchestratorToken || !workerToken) throw new Error('Expected live agent tokens')
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const setAgentEnv = (agentId: string, token: string) => {
          process.env = {
            ...originalEnv,
            HIVE_AGENT_ID: agentId,
            HIVE_AGENT_TOKEN: token,
            HIVE_DATA_DIR: dataDir,
            HIVE_PORT: String(hive.port),
            HIVE_PROJECT_ID: workspace.id,
          }
        }

        setAgentEnv(orchestratorId, orchestratorToken)
        await runTeamCommand(['skill', 'list'])
        const listed = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
          skills: Array<{ qualified_name: string }>
        }
        expect(listed.skills).toContainEqual(
          expect.objectContaining({ qualified_name: 'matt/tdd' })
        )

        await runTeamCommand(['skill', 'load', 'matt/tdd'])
        expect(String(log.mock.calls.at(-1)?.[0])).toContain('PINNED CLI TDD INSTRUCTIONS')

        await runTeamCommand([
          'send',
          'Alice',
          'Implement the real CLI scenario',
          '--skill',
          'matt/tdd',
        ])
        const sent = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
          dispatch_id: string
        }
        expect(hive.store.skills.getDispatchActivation(sent.dispatch_id)).toMatchObject({
          instructionSnapshot: expect.stringContaining('PINNED CLI TDD INSTRUCTIONS'),
          releaseId: release.id,
          skillName: 'tdd',
        })

        setAgentEnv(worker.id, workerToken)
        await runTeamCommand(['skill', 'load', '--dispatch', sent.dispatch_id])
        expect(String(log.mock.calls.at(-1)?.[0])).toContain('PINNED CLI TDD INSTRUCTIONS')
        await runTeamCommand([
          'skill',
          'read',
          '--dispatch',
          sent.dispatch_id,
          'references/guide.md',
        ])
        expect(String(log.mock.calls.at(-1)?.[0])).toBe('CLI reference evidence')

        await waitFor(() => {
          const output = hive.store.getActiveRunByAgentId(workspace.id, worker.id)?.output ?? ''
          expect(output).toContain('<HIVE_SKILL_INSTRUCTIONS>')
          expect(output).toContain('PINNED CLI TDD INSTRUCTIONS')
          expect(output).toContain('Implement the real CLI scenario')
        })
      } finally {
        await hive.close()
      }
    },
    process.platform === 'win32' ? 60_000 : 20_000
  )
})
