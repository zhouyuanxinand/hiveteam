import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createRecordingAgentManager } from '../helpers/recording-agent-manager.js'
import { listenOnFetchSafePort } from '../helpers/test-server.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

const writeSkill = (sourcePath: string) => {
  const skillPath = join(sourcePath, 'skills', 'tdd')
  mkdirSync(join(skillPath, 'references'), { recursive: true })
  writeFileSync(
    join(skillPath, 'SKILL.md'),
    '---\nname: tdd\ndescription: Test-driven development.\n---\nPINNED TDD INSTRUCTIONS'
  )
  writeFileSync(join(skillPath, 'references', 'guide.md'), 'TDD reference')
}

const bindPack = async (
  store: ReturnType<typeof createRuntimeStore>,
  workspaceId: string,
  sourcePath: string
) => {
  const release = await store.skills.resolvePack({
    packName: 'matt',
    source: { path: sourcePath, type: 'local' },
  })
  const plan = await store.skills.plan(workspaceId, {
    action: 'bind',
    nativeExposure: [],
    packName: 'matt',
    profiles: { coder: ['tdd'], orchestrator: ['tdd'] },
    releaseId: release.id,
  })
  await store.skills.applyPlan(workspaceId, plan.id)
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

describe('team Skill routes', () => {
  test('authorizes list/load/read against the exact dispatch activation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-skill-http-'))
    const workspacePath = join(dataDir, 'workspace')
    const sourcePath = join(dataDir, 'source')
    mkdirSync(workspacePath, { recursive: true })
    writeSkill(sourcePath)
    tempDirs.push(dataDir)

    const recording = createRecordingAgentManager()
    const store = createRuntimeStore({ agentManager: recording.manager, dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Skill HTTP')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected Orchestrator')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, orchestrator.id, { command: 'custom-agent' })
    store.configureAgentLaunch(workspace.id, worker.id, { command: 'custom-agent' })
    await bindPack(store, workspace.id, sourcePath)
    const orchestratorRun = await store.startAgent(workspace.id, orchestrator.id, {
      hivePort: '4010',
    })
    const workerRun = await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    const orchestratorToken = store.peekAgentToken(orchestrator.id)
    const workerToken = store.peekAgentToken(worker.id)
    if (!orchestratorToken || !workerToken) throw new Error('Expected active agent tokens')

    const app = createApp({ store })
    const port = await listenOnFetchSafePort(app.server)
    const baseUrl = `http://127.0.0.1:${port}`
    try {
      const listResponse = await fetch(
        `${baseUrl}/api/team/skills?project_id=${encodeURIComponent(workspace.id)}`,
        {
          headers: {
            'x-hive-agent-id': orchestrator.id,
            'x-hive-agent-token': orchestratorToken,
          },
        }
      )
      expect(listResponse.status).toBe(200)
      await expect(listResponse.json()).resolves.toMatchObject({
        skills: [{ qualified_name: 'matt/tdd', release_id: expect.any(String) }],
      })

      const loadResponse = await fetch(`${baseUrl}/api/team/skills/load`, {
        body: JSON.stringify({
          from_agent_id: orchestrator.id,
          project_id: workspace.id,
          skill_name: 'matt/tdd',
          token: orchestratorToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(loadResponse.status).toBe(200)
      await expect(loadResponse.json()).resolves.toMatchObject({
        instruction_snapshot: expect.stringContaining('PINNED TDD INSTRUCTIONS'),
        skill_name: 'tdd',
      })

      const emptySkillResponse = await fetch(`${baseUrl}/api/team/send`, {
        body: JSON.stringify({
          from_agent_id: orchestrator.id,
          project_id: workspace.id,
          skill_name: '',
          text: 'Do not silently drop an invalid activation',
          to: worker.name,
          token: orchestratorToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(emptySkillResponse.status).toBe(400)

      const sendResponse = await fetch(`${baseUrl}/api/team/send`, {
        body: JSON.stringify({
          from_agent_id: orchestrator.id,
          project_id: workspace.id,
          skill_name: 'matt/tdd',
          text: 'Implement the feature',
          to: worker.name,
          token: orchestratorToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(sendResponse.status).toBe(202)
      const sent = (await sendResponse.json()) as { dispatch_id: string }

      const ambiguousLoadResponse = await fetch(`${baseUrl}/api/team/skills/load`, {
        body: JSON.stringify({
          dispatch_id: sent.dispatch_id,
          from_agent_id: orchestrator.id,
          project_id: workspace.id,
          skill_name: 'matt/tdd',
          token: orchestratorToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(ambiguousLoadResponse.status).toBe(400)

      const workerBrowseResponse = await fetch(`${baseUrl}/api/team/skills/load`, {
        body: JSON.stringify({
          from_agent_id: worker.id,
          project_id: workspace.id,
          skill_name: 'matt/tdd',
          token: workerToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(workerBrowseResponse.status).toBe(403)
      await expect(workerBrowseResponse.json()).resolves.toMatchObject({
        error_code: 'skill_not_allowed',
      })

      const dispatchLoadResponse = await fetch(`${baseUrl}/api/team/skills/load`, {
        body: JSON.stringify({
          dispatch_id: sent.dispatch_id,
          from_agent_id: worker.id,
          project_id: workspace.id,
          token: workerToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(dispatchLoadResponse.status).toBe(200)
      await expect(dispatchLoadResponse.json()).resolves.toMatchObject({
        instruction_snapshot: expect.stringContaining('PINNED TDD INSTRUCTIONS'),
      })

      const readResponse = await fetch(`${baseUrl}/api/team/skills/read`, {
        body: JSON.stringify({
          dispatch_id: sent.dispatch_id,
          from_agent_id: worker.id,
          path: 'references/guide.md',
          project_id: workspace.id,
          token: workerToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(readResponse.status).toBe(200)
      await expect(readResponse.json()).resolves.toMatchObject({
        content: 'TDD reference',
        path: 'references/guide.md',
        payload_digest: expect.stringMatching(/^sha256:/u),
      })

      const missingReferenceResponse = await fetch(`${baseUrl}/api/team/skills/read`, {
        body: JSON.stringify({
          dispatch_id: sent.dispatch_id,
          from_agent_id: worker.id,
          path: 'references/missing.md',
          project_id: workspace.id,
          token: workerToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(missingReferenceResponse.status).toBe(404)
      await expect(missingReferenceResponse.json()).resolves.toMatchObject({
        error_code: 'skill_not_found',
      })
    } finally {
      store.stopAgentRun(workerRun.runId)
      store.stopAgentRun(orchestratorRun.runId)
      const closed = new Promise<void>((resolve) => app.server.close(() => resolve()))
      app.server.closeAllConnections()
      await closed
    }
  })
})
