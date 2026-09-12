import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { runTeamCommand } from '../../src/cli/team.js'
import { normalizePtyText } from '../helpers/platform-cli.js'
import { getUiCookie } from '../helpers/ui-session.js'

const RUN_REAL_SMOKE = process.env.HIVE_REAL_MATT_SMOKE === '1'
const tempDirs: string[] = []
const originalEnv = { ...process.env }

const expectOk = async (response: Response, operation: string) => {
  if (!response.ok) {
    throw new Error(`${operation} failed (${response.status}): ${await response.text()}`)
  }
  return response
}

const waitFor = async (assertion: () => void, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
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

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

describe('real Matt Skill Pack smoke', () => {
  test.runIf(RUN_REAL_SMOKE)(
    'binds and dispatches tt-a1i/matt-skills-with-to-goal through the production runtime',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'hive-real-matt-skill-'))
      tempDirs.push(dataDir)
      const workspacePath = join(dataDir, 'workspace')
      mkdirSync(workspacePath, { recursive: true })
      const echoScript = join(workspacePath, 'agent-echo.js')
      writeFileSync(
        echoScript,
        [
          "let input = ''",
          'let reportTimer',
          "process.stdin.setEncoding('utf8')",
          "process.stdin.on('data', chunk => {",
          '  input += chunk',
          "  if (!input.includes('</hive-system-reminder>')) return",
          '  clearTimeout(reportTimer)',
          '  reportTimer = setTimeout(() => {',
          "    const markers = input.split('<HIVE_SKILL_INSTRUCTIONS>').length - 1",
          "    const qualified = input.includes('qualified_name: matt/to-goal')",
          "    const task = input.includes('Turn this request into a verifiable Hive goal')",
          "    process.stdout.write('\\nMATT_PROBE markers=' + markers + ' qualified=' + qualified + ' task=' + task + '\\n')",
          '  }, 50)',
          '})',
          '',
        ].join('\n')
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
              name: 'Real Matt smoke',
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
              source: {
                ref: 'main',
                repository: 'tt-a1i/matt-skills-with-to-goal',
                type: 'github',
              },
            }),
            headers: jsonHeaders,
            method: 'POST',
          }),
          'resolve real Matt Pack'
        )
        const release = (await releaseResponse.json()) as {
          content_digest: string
          id: string
          manifest: {
            file_count: number
            skills: Array<{
              content_digest: string
              name: string
              relative_path: string
              script_paths: string[]
            }>
          }
          resolved_revision: string
        }
        const toGoal = release.manifest.skills.find((skill) => skill.name === 'to-goal')
        expect(release.resolved_revision).toMatch(/^[a-f0-9]{40}$/u)
        expect(release.content_digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
        expect(toGoal).toBeDefined()

        const planResponse = await expectOk(
          await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/plans`, {
            body: JSON.stringify({
              action: 'bind',
              native_exposure: ['to-goal'],
              pack_name: 'matt',
              profiles: { coder: ['to-goal'], orchestrator: ['to-goal'] },
              release_id: release.id,
            }),
            headers: jsonHeaders,
            method: 'POST',
          }),
          'plan real Matt bind'
        )
        const plan = (await planResponse.json()) as { id: string }
        const applyResponse = await expectOk(
          await fetch(
            `${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/plans/${plan.id}/apply`,
            { headers: { cookie }, method: 'POST' }
          ),
          'apply real Matt bind'
        )
        const receipt = (await applyResponse.json()) as { id: string }
        const placementPath = join(workspacePath, '.agents', 'skills', 'to-goal')
        expect(lstatSync(placementPath).isSymbolicLink()).toBe(true)
        const nativeSkillFile = join(realpathSync(placementPath), 'SKILL.md')
        const exactSkillSnapshot = readFileSync(nativeSkillFile, 'utf8')

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
        const catalog = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
          skills: Array<{ qualified_name: string }>
        }
        expect(catalog.skills.map((skill) => skill.qualified_name)).toEqual(['matt/to-goal'])
        await runTeamCommand(['skill', 'load', 'matt/to-goal'])
        expect(String(log.mock.calls.at(-1)?.[0])).toBe(exactSkillSnapshot)

        await runTeamCommand([
          'send',
          'Alice',
          'Turn this request into a verifiable Hive goal',
          '--skill',
          'matt/to-goal',
        ])
        const sent = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
          dispatch_id: string
        }
        const activation = hive.store.skills.getDispatchActivation(sent.dispatch_id)
        expect(activation).toMatchObject({
          instructionSnapshot: exactSkillSnapshot,
          releaseId: release.id,
          skillDigest: toGoal?.content_digest,
          skillName: 'to-goal',
        })
        await waitFor(() => {
          const output = normalizePtyText(
            hive.store.getActiveRunByAgentId(workspace.id, worker.id)?.output ?? ''
          )
          expect(output).toContain('MATT_PROBE markers=1 qualified=true task=true')
        })

        const undoResponse = await expectOk(
          await fetch(
            `${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/receipts/${receipt.id}/undo`,
            { headers: { cookie }, method: 'POST' }
          ),
          'undo real Matt bind'
        )
        await expect(undoResponse.json()).resolves.toMatchObject({ state: 'rolled_back' })
        expect(existsSync(placementPath)).toBe(false)
        expect(existsSync(join(workspacePath, '.hive', 'skill-packs.json'))).toBe(false)
        expect(existsSync(join(workspacePath, '.hive', 'skill-packs.lock.json'))).toBe(false)

        setAgentEnv(worker.id, workerToken)
        await runTeamCommand(['skill', 'load', '--dispatch', sent.dispatch_id])
        expect(String(log.mock.calls.at(-1)?.[0])).toBe(exactSkillSnapshot)
        console.info(
          JSON.stringify({
            content_digest: release.content_digest,
            dispatch_id: sent.dispatch_id,
            file_count: release.manifest.file_count,
            resolved_revision: release.resolved_revision,
            script_count: release.manifest.skills.reduce(
              (count, skill) => count + skill.script_paths.length,
              0
            ),
            skill_count: release.manifest.skills.length,
            to_goal_digest: toGoal?.content_digest,
          })
        )
      } finally {
        await hive.close()
      }
    },
    180_000
  )
})
