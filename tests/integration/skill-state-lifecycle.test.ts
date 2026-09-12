import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

const countRows = (db: Database.Database, table: string, workspaceId: string) => {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`)
    .get(workspaceId) as { count: number }
  return row.count
}

describe('Skill operational state lifecycle', () => {
  test('cleans Worker and Workspace rows while preserving portable Skill files', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-lifecycle-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    const skillPath = join(dataDir, 'source', 'skills', 'tdd')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(
      join(skillPath, 'SKILL.md'),
      '---\nname: tdd\ndescription: Test-driven development.\n---\nLifecycle instructions.'
    )

    const store = createRuntimeStore({ dataDir, skillHomePath: join(dataDir, 'home') })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Skill lifecycle')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const release = await store.skills.resolvePack({
      packName: 'matt',
      source: { path: join(dataDir, 'source'), type: 'local' },
    })
    const plan = await store.skills.plan(workspace.id, {
      action: 'bind',
      nativeExposure: ['tdd'],
      packName: 'matt',
      profiles: { coder: ['tdd'], orchestrator: ['tdd'] },
      releaseId: release.id,
    })
    await store.skills.applyPlan(workspace.id, plan.id)
    await store.skills.scan(workspace.id)
    const dispatch = await store.dispatchTaskByWorkerName(
      workspace.id,
      'Alice',
      'Exercise lifecycle cleanup',
      { skillName: 'matt/tdd' }
    )
    expect(store.skills.getDispatchActivation(dispatch.id)).not.toBeNull()

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    expect(countRows(db, 'skill_snapshots', workspace.id)).toBe(2)
    expect(countRows(db, 'skill_change_plans', workspace.id)).toBe(1)
    expect(countRows(db, 'skill_change_attempts', workspace.id)).toBe(1)
    expect(countRows(db, 'skill_placements', workspace.id)).toBe(1)
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM dispatch_skill_activations activation
             JOIN dispatches dispatch ON dispatch.id = activation.dispatch_id
            WHERE dispatch.workspace_id = ?`
        )
        .get(workspace.id)
    ).toMatchObject({ count: 1 })

    store.deleteWorker(workspace.id, worker.id)
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM dispatch_skill_activations activation
             JOIN dispatches dispatch ON dispatch.id = activation.dispatch_id
            WHERE dispatch.workspace_id = ?`
        )
        .get(workspace.id)
    ).toMatchObject({ count: 0 })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM skill_snapshots WHERE agent_id = ?').get(worker.id)
    ).toMatchObject({ count: 0 })

    const configPath = join(workspacePath, '.hive', 'skill-packs.json')
    const lockPath = join(workspacePath, '.hive', 'skill-packs.lock.json')
    expect(existsSync(configPath)).toBe(true)
    expect(existsSync(lockPath)).toBe(true)

    await store.deleteWorkspace(workspace.id)

    for (const table of [
      'skill_snapshots',
      'skill_change_plans',
      'skill_change_attempts',
      'skill_placements',
    ]) {
      expect(countRows(db, table, workspace.id)).toBe(0)
    }
    expect(existsSync(configPath)).toBe(true)
    expect(existsSync(lockPath)).toBe(true)
    db.close()
  })
})
