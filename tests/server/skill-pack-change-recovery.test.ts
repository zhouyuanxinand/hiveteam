import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'
import type { InternalSkillChangeOperation } from '../../src/server/skill-pack-change-types.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

const writeSkill = (sourcePath: string, version: string) => {
  const skillPath = join(sourcePath, 'skills', 'to-goal')
  mkdirSync(skillPath, { recursive: true })
  writeFileSync(
    join(skillPath, 'SKILL.md'),
    `---\nname: to-goal\ndescription: Create a verifiable goal.\n---\n${version} GOAL INSTRUCTIONS`
  )
}

const resolveAndPlan = async (
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
    nativeExposure: ['to-goal'],
    packName: 'matt',
    profiles: { orchestrator: ['to-goal'] },
    releaseId: release.id,
  })
  return { plan, release }
}

const removeStore = async (store: ReturnType<typeof createRuntimeStore>) => {
  const index = stores.indexOf(store)
  if (index >= 0) stores.splice(index, 1)
  await store.close()
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

describe('Skill Pack changes and recovery', () => {
  test('restores the previous native release when an update receipt is undone', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-update-undo-'))
    const workspacePath = join(dataDir, 'workspace')
    const sourcePath = join(dataDir, 'source')
    mkdirSync(workspacePath, { recursive: true })
    writeSkill(sourcePath, 'V1')
    tempDirs.push(dataDir)

    const store = createRuntimeStore({ dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Update Undo')
    const v1 = await resolveAndPlan(store, workspace.id, sourcePath, 'bind')
    const bindReceipt = await store.skills.applyPlan(workspace.id, v1.plan.id)
    const placementPath = join(workspacePath, '.agents', 'skills', 'to-goal')
    const v1Target = realpathSync(placementPath)

    writeSkill(sourcePath, 'V2')
    const v2 = await resolveAndPlan(store, workspace.id, sourcePath, 'update')
    expect(v2.release.id).not.toBe(v1.release.id)
    const updateReceipt = await store.skills.applyPlan(workspace.id, v2.plan.id)
    expect(realpathSync(placementPath)).not.toBe(v1Target)

    await expect(store.skills.undoReceipt(workspace.id, bindReceipt.id)).rejects.toMatchObject({
      code: 'receipt_not_undoable',
    })
    const beforeUpdateUndo = await store.skills.inspect(workspace.id)
    expect(
      beforeUpdateUndo.receipts.find((receipt) => receipt.id === bindReceipt.id)?.undoAvailable
    ).toBe(false)

    const undone = await store.skills.undoReceipt(workspace.id, updateReceipt.id)

    expect(undone.state).toBe('rolled_back')
    expect(realpathSync(placementPath)).toBe(v1Target)
    expect(
      JSON.parse(readFileSync(join(workspacePath, '.hive', 'skill-packs.lock.json'), 'utf8'))
    ).toMatchObject({ packs: [{ release_id: v1.release.id }] })

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    const placements = db
      .prepare('SELECT release_id, state FROM skill_placements WHERE workspace_id = ?')
      .all(workspace.id) as Array<{ release_id: string; state: string }>
    db.close()
    expect(placements).toEqual(
      expect.arrayContaining([
        { release_id: v1.release.id, state: 'active' },
        { release_id: v2.release.id, state: 'removed' },
      ])
    )

    await expect(store.skills.undoReceipt(workspace.id, bindReceipt.id)).resolves.toMatchObject({
      state: 'rolled_back',
    })
  })

  test('rejects a stale Change Plan before creating an attempt or mutating managed files', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-plan-drift-'))
    const workspacePath = join(dataDir, 'workspace')
    const sourcePath = join(dataDir, 'source')
    mkdirSync(workspacePath, { recursive: true })
    writeSkill(sourcePath, 'V1')
    tempDirs.push(dataDir)

    const store = createRuntimeStore({ dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Plan Drift')
    const { plan } = await resolveAndPlan(store, workspace.id, sourcePath, 'bind')
    const configPath = join(workspacePath, '.hive', 'skill-packs.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{"user_owned":true}\n')

    await expect(store.skills.applyPlan(workspace.id, plan.id)).rejects.toMatchObject({
      code: 'drift_detected',
    })
    expect(readFileSync(configPath, 'utf8')).toBe('{"user_owned":true}\n')
    expect(existsSync(join(workspacePath, '.hive', 'skill-packs.lock.json'))).toBe(false)
    expect(existsSync(join(workspacePath, '.agents', 'skills', 'to-goal'))).toBe(false)

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    const attemptCount = db
      .prepare('SELECT COUNT(*) AS count FROM skill_change_attempts')
      .get() as {
      count: number
    }
    db.close()
    expect(attemptCount.count).toBe(0)
  })

  test('rolls back an interrupted partial Apply when the runtime reopens', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-recovery-'))
    const workspacePath = join(dataDir, 'workspace')
    const sourcePath = join(dataDir, 'source')
    mkdirSync(workspacePath, { recursive: true })
    writeSkill(sourcePath, 'V1')
    tempDirs.push(dataDir)

    const firstStore = createRuntimeStore({ dataDir })
    stores.push(firstStore)
    const workspace = firstStore.createWorkspace(workspacePath, 'Recovery')
    const { plan } = await resolveAndPlan(firstStore, workspace.id, sourcePath, 'bind')
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    const row = db
      .prepare('SELECT internal_state_json FROM skill_change_plans WHERE id = ?')
      .get(plan.id) as { internal_state_json: string }
    const internal = JSON.parse(row.internal_state_json) as {
      internalOperations: Array<{
        after: { target: string | null }
        kind: string
        path: string
      }>
    }
    const firstOperation = internal.internalOperations[0]
    if (!firstOperation || firstOperation.kind !== 'placement') {
      throw new Error('Expected native placement to be the first operation')
    }
    if (!firstOperation.after.target) throw new Error('Expected placement source target')
    mkdirSync(dirname(firstOperation.path), { recursive: true })
    symlinkSync(
      firstOperation.after.target,
      firstOperation.path,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const attemptId = randomUUID()
    db.prepare(
      `INSERT INTO skill_change_attempts (
         id, workspace_id, plan_id, state, journal_json, error, started_at, completed_at
       ) VALUES (?, ?, ?, 'applying', ?, NULL, ?, NULL)`
    ).run(
      attemptId,
      workspace.id,
      plan.id,
      JSON.stringify({
        completedOperationIndexes: [],
        direction: 'apply',
        pendingOperationIndex: 0,
      }),
      Date.now()
    )
    db.close()
    expect(realpathSync(firstOperation.path)).toBe(realpathSync(firstOperation.after.target))
    await removeStore(firstStore)

    const reopened = createRuntimeStore({ dataDir })
    stores.push(reopened)
    const inspection = await reopened.skills.inspect(workspace.id)

    expect(existsSync(firstOperation.path)).toBe(false)
    expect(inspection.receipts).toContainEqual(
      expect.objectContaining({
        error: 'Interrupted Apply was rolled back',
        id: attemptId,
        state: 'rolled_back',
      })
    )
  })

  test('surfaces recovery_required and blocks Apply when compensation cannot match disk', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-recovery-required-'))
    const workspacePath = join(dataDir, 'workspace')
    const sourcePath = join(dataDir, 'source')
    mkdirSync(workspacePath, { recursive: true })
    writeSkill(sourcePath, 'V1')
    tempDirs.push(dataDir)

    const firstStore = createRuntimeStore({ dataDir })
    stores.push(firstStore)
    const workspace = firstStore.createWorkspace(workspacePath, 'Recovery required')
    const { plan } = await resolveAndPlan(firstStore, workspace.id, sourcePath, 'bind')
    const attemptId = randomUUID()
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    const row = db
      .prepare('SELECT internal_state_json FROM skill_change_plans WHERE id = ?')
      .get(plan.id) as { internal_state_json: string }
    const internal = JSON.parse(row.internal_state_json) as {
      internalOperations: InternalSkillChangeOperation[]
    }
    const firstOperation = internal.internalOperations[0]
    if (!firstOperation || firstOperation.kind !== 'placement') {
      throw new Error('Expected native placement to be the first operation')
    }
    mkdirSync(firstOperation.path, { recursive: true })
    db.prepare(
      `INSERT INTO skill_change_attempts (
         id, workspace_id, plan_id, state, journal_json, error, started_at, completed_at
       ) VALUES (?, ?, ?, 'applying', ?, NULL, ?, NULL)`
    ).run(
      attemptId,
      workspace.id,
      plan.id,
      JSON.stringify({ completedOperationIndexes: [0], direction: 'apply' }),
      Date.now()
    )
    db.close()
    await removeStore(firstStore)

    const reopened = createRuntimeStore({ dataDir })
    stores.push(reopened)
    const inspection = await reopened.skills.inspect(workspace.id)

    expect(inspection.receipts).toContainEqual(
      expect.objectContaining({ id: attemptId, state: 'recovery_required' })
    )
    await expect(reopened.skills.applyPlan(workspace.id, plan.id)).rejects.toMatchObject({
      code: 'recovery_required',
    })
  })

  test('persists partial compensation progress and resumes after drift is repaired', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-recovery-resume-'))
    const workspacePath = join(dataDir, 'workspace')
    const sourcePath = join(dataDir, 'source')
    mkdirSync(workspacePath, { recursive: true })
    writeSkill(sourcePath, 'V1')
    tempDirs.push(dataDir)

    const firstStore = createRuntimeStore({ dataDir })
    stores.push(firstStore)
    const workspace = firstStore.createWorkspace(workspacePath, 'Recovery resume')
    const { plan } = await resolveAndPlan(firstStore, workspace.id, sourcePath, 'bind')
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    const row = db
      .prepare('SELECT internal_state_json FROM skill_change_plans WHERE id = ?')
      .get(plan.id) as { internal_state_json: string }
    const internal = JSON.parse(row.internal_state_json) as {
      internalOperations: InternalSkillChangeOperation[]
    }
    const placementIndex = internal.internalOperations.findIndex(
      (operation) => operation.kind === 'placement'
    )
    const lockIndex = internal.internalOperations.findIndex(
      (operation) => operation.kind === 'write_file' && operation.publicKind === 'write_lock'
    )
    const placement = internal.internalOperations[placementIndex]
    const lock = internal.internalOperations[lockIndex]
    if (placementIndex < 0 || placement?.kind !== 'placement' || !placement.after.target) {
      throw new Error('Expected a native placement operation')
    }
    if (lockIndex < 0 || lock?.kind !== 'write_file' || lock.after.content === null) {
      throw new Error('Expected a lock file operation')
    }

    mkdirSync(dirname(placement.path), { recursive: true })
    symlinkSync(
      placement.after.target,
      placement.path,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    mkdirSync(dirname(lock.path), { recursive: true })
    writeFileSync(lock.path, lock.after.content)
    rmSync(placement.path, { force: true, recursive: true })
    mkdirSync(placement.path)

    const attemptId = randomUUID()
    db.prepare(
      `INSERT INTO skill_change_attempts (
         id, workspace_id, plan_id, state, journal_json, error, started_at, completed_at
       ) VALUES (?, ?, ?, 'applying', ?, NULL, ?, NULL)`
    ).run(
      attemptId,
      workspace.id,
      plan.id,
      JSON.stringify({
        completedOperationIndexes: [placementIndex, lockIndex],
        direction: 'apply',
      }),
      Date.now()
    )
    db.close()
    await removeStore(firstStore)

    const driftedStore = createRuntimeStore({ dataDir })
    stores.push(driftedStore)
    const driftedInspection = await driftedStore.skills.inspect(workspace.id)
    expect(driftedInspection.receipts).toContainEqual(
      expect.objectContaining({ id: attemptId, state: 'recovery_required' })
    )
    expect(existsSync(lock.path)).toBe(false)
    const progressDb = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    const progress = progressDb
      .prepare('SELECT journal_json FROM skill_change_attempts WHERE id = ?')
      .get(attemptId) as { journal_json: string }
    progressDb.close()
    expect(JSON.parse(progress.journal_json)).toMatchObject({
      completedOperationIndexes: [placementIndex],
      pendingOperationIndex: null,
    })
    await removeStore(driftedStore)

    rmSync(placement.path, { force: true, recursive: true })
    symlinkSync(
      placement.after.target,
      placement.path,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const repairedStore = createRuntimeStore({ dataDir })
    stores.push(repairedStore)
    const repairedInspection = await repairedStore.skills.inspect(workspace.id)
    expect(existsSync(placement.path)).toBe(false)
    expect(repairedInspection.receipts).toContainEqual(
      expect.objectContaining({
        error: 'Interrupted Apply was rolled back',
        id: attemptId,
        state: 'rolled_back',
      })
    )
  })
})
