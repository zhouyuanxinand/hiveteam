import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { listenOnFetchSafePort } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { force: true, recursive: true })
})

const writeSkill = (root: string, name: string, description: string) => {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}.`
  )
}

describe('Skill Pack inspection routes', () => {
  test('scans real roots, reports conflicts in snake_case, and persists member snapshots', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-routes-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    const skillHomePath = join(dataDir, 'home')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(skillHomePath, { recursive: true })
    mkdirSync(join(dataDir, '.git'), { recursive: true })
    writeSkill(join(workspacePath, '.agents', 'skills'), 'to-goal', 'Workspace goal Skill.')
    writeSkill(join(dataDir, '.agents', 'skills'), 'repo-only', 'Repository-level Skill.')
    writeSkill(join(skillHomePath, '.codex', 'skills'), 'to-goal', 'User goal Skill.')

    const store = createRuntimeStore({ dataDir, skillHomePath })
    const workspace = store.createWorkspace(workspacePath, 'Skill workspace')
    const orchestratorId = `${workspace.id}:orchestrator`
    store.configureAgentLaunch(workspace.id, orchestratorId, {
      args: [],
      command: 'codex',
      commandPresetId: 'codex',
    })
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      args: [],
      command: 'custom-agent',
      presetAugmentationDisabled: true,
    })
    const app = createApp({ store })
    const port = await listenOnFetchSafePort(app.server)
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const unauthorized = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs`)
      expect(unauthorized.status).toBe(403)

      const cookie = await getUiCookie(baseUrl)
      const response = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs`, {
        headers: { cookie },
      })
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        conflicts: Array<{ member_ids: string[]; name: string; paths: string[] }>
        members: Array<{
          agent_id: string
          command_preset_id: string | null
          delivery_status: string
          native_discovery_status: string
          skills: Array<{
            canonical_path: string
            conflict: boolean
            instruction_digest: string
            name: string
          }>
        }>
        scanned_at: number
        summary: { conflict_count: number; effective_skill_count: number }
        workspace_id: string
      }

      expect(payload.workspace_id).toBe(workspace.id)
      expect(payload.scanned_at).toEqual(expect.any(Number))
      expect(payload.summary).toMatchObject({ conflict_count: 1, effective_skill_count: 3 })
      expect(payload.conflicts).toEqual([
        expect.objectContaining({ member_ids: [orchestratorId], name: 'to-goal' }),
      ])
      const orchestrator = payload.members.find((member) => member.agent_id === orchestratorId)
      expect(orchestrator).toMatchObject({
        command_preset_id: 'codex',
        delivery_status: 'not_configured',
        native_discovery_status: 'conflict',
      })
      expect(orchestrator?.skills).toHaveLength(3)
      expect(orchestrator?.skills.filter((skill) => skill.name === 'to-goal')).toHaveLength(2)
      expect(
        orchestrator?.skills
          .filter((skill) => skill.name === 'to-goal')
          .every((skill) => skill.conflict)
      ).toBe(true)
      expect(orchestrator?.skills).toContainEqual(
        expect.objectContaining({ name: 'repo-only', conflict: false })
      )
      expect(orchestrator?.skills[0]?.instruction_digest).toMatch(/^sha256:/u)
      const customWorker = payload.members.find((member) => member.agent_id === worker.id)
      expect(customWorker).toMatchObject({
        command_preset_id: null,
        native_discovery_status: 'unverified',
      })

      const rescan = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/scan`, {
        headers: { cookie },
        method: 'POST',
      })
      expect(rescan.status).toBe(200)

      const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
      const snapshotCount = db
        .prepare('SELECT COUNT(*) AS count FROM skill_snapshots WHERE workspace_id = ?')
        .get(workspace.id) as { count: number }
      db.close()
      expect(snapshotCount.count).toBe(4)
    } finally {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    }
  })

  test('resolves a local Pack into an immutable cache without executing repository scripts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-resolve-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    const sourcePath = join(dataDir, 'source-pack')
    const scriptPath = join(sourcePath, 'skills', 'to-goal', 'scripts', 'probe.js')
    const executionMarker = join(sourcePath, 'executed.txt')
    mkdirSync(workspacePath, { recursive: true })
    writeSkill(join(sourcePath, 'skills'), 'tdd', 'Test-driven development.')
    mkdirSync(join(sourcePath, 'skills', 'to-goal', 'scripts'), { recursive: true })
    writeFileSync(
      join(sourcePath, 'skills', 'to-goal', 'SKILL.md'),
      '---\nname: to-goal\ndescription: Create a verifiable goal.\n---\nGoal instructions.'
    )
    writeFileSync(
      scriptPath,
      `require('node:fs').writeFileSync(${JSON.stringify(executionMarker)}, 'executed')`
    )

    const store = createRuntimeStore({ dataDir, skillHomePath: join(dataDir, 'home') })
    const workspace = store.createWorkspace(workspacePath, 'Resolve workspace')
    const app = createApp({ store })
    const port = await listenOnFetchSafePort(app.server)
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const cookie = await getUiCookie(baseUrl)
      const resolvePack = () =>
        fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/resolve`, {
          body: JSON.stringify({
            name: 'matt',
            source: { path: sourcePath, type: 'local' },
          }),
          headers: { 'content-type': 'application/json', cookie },
          method: 'POST',
        })

      const response = await resolvePack()
      expect(response.status).toBe(200)
      const release = (await response.json()) as {
        cache_key: string
        content_digest: string
        id: string
        manifest: {
          file_count: number
          skills: Array<{
            contains_scripts: boolean
            name: string
            script_paths: string[]
          }>
        }
        pack_name: string
        resolved_revision: string
        source_dirty: boolean
      }
      expect(release).toMatchObject({
        content_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        pack_name: 'matt',
        resolved_revision: expect.stringMatching(/^local:[a-f0-9]{64}$/u),
        source_dirty: false,
      })
      expect(release.manifest.file_count).toBe(3)
      expect(release.manifest.skills.map((skill) => skill.name)).toEqual(['tdd', 'to-goal'])
      expect(release.manifest.skills.find((skill) => skill.name === 'to-goal')).toMatchObject({
        contains_scripts: true,
        script_paths: ['skills/to-goal/scripts/probe.js'],
      })
      expect(release.cache_key).toBe(release.content_digest.slice('sha256:'.length))
      expect(() => statSync(executionMarker)).toThrow()
      expect(statSync(join(dataDir, 'skill-packs', 'cache', release.cache_key)).isDirectory()).toBe(
        true
      )

      const repeatedResponse = await resolvePack()
      expect(repeatedResponse.status).toBe(200)
      const repeated = (await repeatedResponse.json()) as { id: string }
      expect(repeated.id).toBe(release.id)

      const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
      const releaseCount = db
        .prepare('SELECT COUNT(*) AS count FROM skill_pack_releases')
        .get() as { count: number }
      db.close()
      expect(releaseCount.count).toBe(1)
    } finally {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    }
  })

  test('plans, applies, persists, and undoes a bound Pack with an owned Codex placement', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-apply-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    const sourcePath = join(dataDir, 'source-pack')
    mkdirSync(workspacePath, { recursive: true })
    writeSkill(join(sourcePath, 'skills'), 'tdd', 'Test-driven development.')
    writeSkill(join(sourcePath, 'skills'), 'to-goal', 'Create a verifiable goal.')

    const store = createRuntimeStore({ dataDir, skillHomePath: join(dataDir, 'home') })
    const workspace = store.createWorkspace(workspacePath, 'Apply workspace')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const app = createApp({ store })
    const port = await listenOnFetchSafePort(app.server)
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const cookie = await getUiCookie(baseUrl)
      const resolvedResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/resolve`,
        {
          body: JSON.stringify({
            name: 'matt',
            source: { path: sourcePath, type: 'local' },
          }),
          headers: { 'content-type': 'application/json', cookie },
          method: 'POST',
        }
      )
      const release = (await resolvedResponse.json()) as { cache_key: string; id: string }

      const planResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/plans`,
        {
          body: JSON.stringify({
            action: 'bind',
            native_exposure: ['to-goal'],
            pack_name: 'matt',
            profiles: { coder: ['tdd'], orchestrator: ['to-goal'] },
            release_id: release.id,
          }),
          headers: { 'content-type': 'application/json', cookie },
          method: 'POST',
        }
      )
      expect(planResponse.status).toBe(201)
      const plan = (await planResponse.json()) as {
        id: string
        operations: Array<{ kind: string; path: string; skill_name: string | null }>
        status: string
      }
      expect(plan.status).toBe('ready')
      expect(plan.operations.map((operation) => operation.kind)).toEqual([
        'create_placement',
        'write_lock',
        'write_config',
      ])
      expect(plan.operations[0]).toMatchObject({ skill_name: 'to-goal' })

      const applyResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/plans/${plan.id}/apply`,
        { headers: { cookie }, method: 'POST' }
      )
      expect(applyResponse.status).toBe(200)
      const receipt = (await applyResponse.json()) as {
        id: string
        state: string
        undo_available: boolean
      }
      expect(receipt).toMatchObject({ state: 'applied', undo_available: true })

      const configPath = join(workspacePath, '.hive', 'skill-packs.json')
      const lockPath = join(workspacePath, '.hive', 'skill-packs.lock.json')
      const placementPath = join(workspacePath, '.agents', 'skills', 'to-goal')
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
        native_exposure: ['matt/to-goal'],
        packs: [{ enabled: true, name: 'matt' }],
        profiles: { coder: ['matt/tdd'], orchestrator: ['matt/to-goal'] },
        version: 1,
      })
      expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
        packs: [{ name: 'matt', release_id: release.id }],
        version: 1,
      })
      expect(lstatSync(placementPath).isSymbolicLink()).toBe(true)
      expect(realpathSync(placementPath)).toBe(
        realpathSync(join(dataDir, 'skill-packs', 'cache', release.cache_key, 'skills', 'to-goal'))
      )

      const inspectionResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs`,
        { headers: { cookie } }
      )
      const inspection = (await inspectionResponse.json()) as {
        members: Array<{ agent_id: string; delivery_status: string }>
        receipts: Array<{ id: string; state: string }>
      }
      expect(inspection.members.find((member) => member.agent_id === worker.id)).toMatchObject({
        delivery_status: 'ready',
      })
      expect(inspection.receipts).toContainEqual(
        expect.objectContaining({ id: receipt.id, state: 'applied' })
      )

      const undoResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/receipts/${receipt.id}/undo`,
        { headers: { cookie }, method: 'POST' }
      )
      expect(undoResponse.status).toBe(200)
      await expect(undoResponse.json()).resolves.toMatchObject({
        state: 'rolled_back',
        undo_available: false,
      })
      expect(existsSync(configPath)).toBe(false)
      expect(existsSync(lockPath)).toBe(false)
      expect(existsSync(placementPath)).toBe(false)

      const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
      const placement = db
        .prepare('SELECT state FROM skill_placements WHERE workspace_id = ?')
        .get(workspace.id) as { state: string }
      db.close()
      expect(placement.state).toBe('removed')
    } finally {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    }
  })

  test('blocks an unmanaged native target during planning without overwriting it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-conflict-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    const sourcePath = join(dataDir, 'source-pack')
    const unmanagedPath = join(workspacePath, '.agents', 'skills', 'to-goal')
    mkdirSync(unmanagedPath, { recursive: true })
    writeFileSync(join(unmanagedPath, 'owner.txt'), 'user-owned')
    writeSkill(join(sourcePath, 'skills'), 'to-goal', 'Create a verifiable goal.')

    const store = createRuntimeStore({ dataDir, skillHomePath: join(dataDir, 'home') })
    const workspace = store.createWorkspace(workspacePath, 'Conflict workspace')
    const app = createApp({ store })
    const port = await listenOnFetchSafePort(app.server)
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const cookie = await getUiCookie(baseUrl)
      const resolvedResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/resolve`,
        {
          body: JSON.stringify({
            name: 'matt',
            source: { path: sourcePath, type: 'local' },
          }),
          headers: { 'content-type': 'application/json', cookie },
          method: 'POST',
        }
      )
      const release = (await resolvedResponse.json()) as { id: string }
      const planResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/plans`,
        {
          body: JSON.stringify({
            action: 'bind',
            native_exposure: ['to-goal'],
            pack_name: 'matt',
            profiles: {},
            release_id: release.id,
          }),
          headers: { 'content-type': 'application/json', cookie },
          method: 'POST',
        }
      )
      expect(planResponse.status).toBe(409)
      await expect(planResponse.json()).resolves.toMatchObject({
        error_code: 'placement_conflict',
      })
      expect(readFileSync(join(unmanagedPath, 'owner.txt'), 'utf8')).toBe('user-owned')
      expect(existsSync(join(workspacePath, '.hive', 'skill-packs.json'))).toBe(false)
    } finally {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    }
  })

  test('blocks a second enabled Pack that declares an existing Skill name', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-name-conflict-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    const firstSource = join(dataDir, 'first-pack')
    const secondSource = join(dataDir, 'second-pack')
    mkdirSync(workspacePath, { recursive: true })
    writeSkill(join(firstSource, 'skills'), 'shared', 'First shared Skill.')
    writeSkill(join(secondSource, 'skills'), 'shared', 'Second shared Skill.')

    const store = createRuntimeStore({ dataDir, skillHomePath: join(dataDir, 'home') })
    const workspace = store.createWorkspace(workspacePath, 'Duplicate Skill workspace')
    const app = createApp({ store })
    const port = await listenOnFetchSafePort(app.server)
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const cookie = await getUiCookie(baseUrl)
      const resolveRelease = async (name: string, path: string) => {
        const response = await fetch(
          `${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/resolve`,
          {
            body: JSON.stringify({ name, source: { path, type: 'local' } }),
            headers: { 'content-type': 'application/json', cookie },
            method: 'POST',
          }
        )
        expect(response.status).toBe(200)
        return (await response.json()) as { id: string }
      }
      const createPlan = (name: string, releaseId: string) =>
        fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/plans`, {
          body: JSON.stringify({
            action: 'bind',
            native_exposure: [],
            pack_name: name,
            profiles: {},
            release_id: releaseId,
          }),
          headers: { 'content-type': 'application/json', cookie },
          method: 'POST',
        })

      const firstRelease = await resolveRelease('first', firstSource)
      const firstPlanResponse = await createPlan('first', firstRelease.id)
      expect(firstPlanResponse.status).toBe(201)
      const firstPlan = (await firstPlanResponse.json()) as { id: string }
      const applied = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs/plans/${firstPlan.id}/apply`,
        { headers: { cookie }, method: 'POST' }
      )
      expect(applied.status).toBe(200)

      const secondRelease = await resolveRelease('second', secondSource)
      const conflict = await createPlan('second', secondRelease.id)

      expect(conflict.status).toBe(409)
      await expect(conflict.json()).resolves.toMatchObject({
        error_code: 'skill_name_conflict',
      })
      const configuration = JSON.parse(
        readFileSync(join(workspacePath, '.hive', 'skill-packs.json'), 'utf8')
      ) as { packs: Array<{ name: string }> }
      expect(configuration.packs.map((pack) => pack.name)).toEqual(['first'])
    } finally {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    }
  })
})
