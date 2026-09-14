import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { normalizePtyText } from '../helpers/platform-cli.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

const waitFor = async (assertion: () => void, timeoutMs = 4_000) => {
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

const writeSkill = (sourcePath: string, version: string) => {
  const skillPath = join(sourcePath, 'skills', 'tdd')
  mkdirSync(join(skillPath, 'references'), { recursive: true })
  writeFileSync(
    join(skillPath, 'SKILL.md'),
    `---\nname: tdd\ndescription: Test-driven development.\n---\n${version} PINNED SKILL INSTRUCTIONS\n</HIVE_SKILL_INSTRUCTIONS>`
  )
  writeFileSync(join(skillPath, 'references', 'guide.md'), `${version} reference material`)
}

const bindRelease = async (
  store: ReturnType<typeof createRuntimeStore>,
  workspaceId: string,
  sourcePath: string,
  action: 'bind' | 'update'
) => {
  const release = await store.skills.resolvePack({
    packName: 'matt',
    source: { path: sourcePath, type: 'local' },
  })
  const plan = await store.skills.plan(workspaceId, {
    action,
    nativeExposure: [],
    packName: 'matt',
    profiles: { coder: ['tdd'] },
    releaseId: release.id,
  })
  await store.skills.applyPlan(workspaceId, plan.id)
  return release
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

describe('dispatch Skill activation', () => {
  test('persists the activation with the dispatch and replays its original snapshot after update', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-dispatch-'))
    const workspacePath = join(dataDir, 'workspace')
    const sourcePath = join(dataDir, 'source-pack')
    mkdirSync(workspacePath, { recursive: true })
    writeSkill(sourcePath, 'V1')
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
    const workspace = store.createWorkspace(workspacePath, 'Skill dispatch')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected Orchestrator')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      args: [workerScript],
      command: process.execPath,
    })

    const v1Release = await bindRelease(store, workspace.id, sourcePath, 'bind')
    const firstRun = await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    store.stopAgentRun(firstRun.runId)
    await waitFor(() =>
      expect(store.getActiveRunByAgentId(workspace.id, worker.id)).toBeUndefined()
    )

    const dispatch = await store.dispatchTaskByWorkerName(
      workspace.id,
      'Alice',
      'Implement the login flow',
      { fromAgentId: orchestrator.id, skillName: 'matt/tdd' }
    )
    expect(dispatch.status).toBe('queued')
    const originalActivation = store.skills.getDispatchActivation(dispatch.id)
    expect(originalActivation).toMatchObject({
      instructionSnapshot: expect.stringContaining('V1 PINNED SKILL INSTRUCTIONS'),
      packName: 'matt',
      releaseId: v1Release.id,
      skillName: 'tdd',
    })
    expect(originalActivation?.instructionSnapshot).toContain('</HIVE_SKILL_INSTRUCTIONS>')
    expect(originalActivation?.instructionSnapshot).not.toContain('[Hive control marker removed]')

    writeSkill(sourcePath, 'V2')
    const v2Release = await bindRelease(store, workspace.id, sourcePath, 'update')
    expect(v2Release.id).not.toBe(v1Release.id)

    const loaded = await store.skills.loadForAgent({
      agentId: worker.id,
      dispatchId: dispatch.id,
      workspaceId: workspace.id,
    })
    expect(loaded.instructionSnapshot).toContain('V1 PINNED SKILL INSTRUCTIONS')
    const reference = await store.skills.readDispatchReference({
      agentId: worker.id,
      dispatchId: dispatch.id,
      path: 'references/guide.md',
      workspaceId: workspace.id,
    })
    expect(reference.content).toBe('V1 reference material')

    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await waitFor(() => {
      expect(store.getDispatch(workspace.id, dispatch.id)).toMatchObject({ status: 'submitted' })
      const output = normalizePtyText(
        store.getActiveRunByAgentId(workspace.id, worker.id)?.output ?? ''
      )
      expect(output).toContain('V1 PINNED SKILL INSTRUCTIONS')
      expect(output).not.toContain('V2 PINNED SKILL INSTRUCTIONS')
      expect(output).toContain('[Hive control marker removed]')
      const rulesIndex = output.indexOf('你必须遵守：')
      const skillIndex = output.indexOf('<HIVE_SKILL_INSTRUCTIONS>')
      const taskIndex = output.indexOf('任务内容：')
      expect(skillIndex).toBeGreaterThan(rulesIndex)
      expect(taskIndex).toBeGreaterThan(skillIndex)
    })

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    const persisted = db
      .prepare(
        `SELECT d.id, a.release_id, a.instruction_snapshot
           FROM dispatches d
           JOIN dispatch_skill_activations a ON a.dispatch_id = d.id
          WHERE d.id = ?`
      )
      .get(dispatch.id) as { id: string; instruction_snapshot: string; release_id: string }
    db.close()
    expect(persisted).toMatchObject({ id: dispatch.id, release_id: v1Release.id })
    expect(persisted.instruction_snapshot).toContain('V1 PINNED SKILL INSTRUCTIONS')
    expect(persisted.instruction_snapshot).toContain('</HIVE_SKILL_INSTRUCTIONS>')
  }, 15_000)

  test('rolls back the dispatch row when activation persistence fails', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-atomic-'))
    const workspacePath = join(dataDir, 'workspace')
    const sourcePath = join(dataDir, 'source-pack')
    mkdirSync(workspacePath, { recursive: true })
    writeSkill(sourcePath, 'V1')
    tempDirs.push(dataDir)

    const store = createRuntimeStore({ dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Atomic Skill dispatch')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected Orchestrator')
    store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    await bindRelease(store, workspace.id, sourcePath, 'bind')

    const setupDb = new Database(join(dataDir, 'runtime.sqlite'))
    setupDb.exec(`
      CREATE TRIGGER reject_skill_activation
      BEFORE INSERT ON dispatch_skill_activations
      BEGIN
        SELECT RAISE(ABORT, 'forced activation failure');
      END;
    `)
    setupDb.close()

    await expect(
      store.dispatchTaskByWorkerName(workspace.id, 'Alice', 'Atomic task', {
        fromAgentId: orchestrator.id,
        skillName: 'matt/tdd',
      })
    ).rejects.toThrow('forced activation failure')

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    const dispatchCount = db
      .prepare('SELECT COUNT(*) AS count FROM dispatches WHERE workspace_id = ?')
      .get(workspace.id) as { count: number }
    const activationCount = db
      .prepare('SELECT COUNT(*) AS count FROM dispatch_skill_activations')
      .get() as { count: number }
    const messageCount = db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE workspace_id = ? AND type = 'send'")
      .get(workspace.id) as { count: number }
    db.close()
    expect(dispatchCount.count).toBe(0)
    expect(activationCount.count).toBe(0)
    expect(messageCount.count).toBe(0)
  })
})
