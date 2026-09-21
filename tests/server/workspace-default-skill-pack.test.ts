import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import { readWorkspaceSkillFiles } from '../../src/server/skill-pack-config.js'
import { SkillPackChangeError } from '../../src/server/skill-pack-operation-errors.js'
import { SkillPackResolutionError } from '../../src/server/skill-pack-source.js'
import { defaultSkillPackSelection } from '../../src/shared/skill-pack-defaults.js'
import { seedDefaultSkillPackCache } from '../helpers/default-skill-pack-fixture.js'
import { startAuthorizedTestServer as startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

vi.unmock('../../src/server/default-workspace-skill-pack.js')

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-default-pack-'))
  cleanup.push(() => rmSync(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }))
  const dataDir = join(root, 'data')
  const server = await startTestServer({ dataDir })
  cleanup.push(server.close)
  const fixture = await seedDefaultSkillPackCache(dataDir, root)
  const cookie = await getUiCookie(server.baseUrl)
  const project = (name: string) => {
    const path = join(root, name)
    mkdirSync(path, { recursive: true })
    return path
  }
  const create = (path: string, extra: Record<string, unknown> = {}, auth = cookie) =>
    fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: auth },
      body: JSON.stringify({
        path,
        name: 'New workspace',
        autostart_orchestrator: false,
        ...extra,
      }),
    })
  return { ...server, ...fixture, cookie, create, project, root }
}

describe('new workspace default Skill Packs', () => {
  test('binds immutable Matt and Janitor releases, role profiles and native entry points before returning 201', async () => {
    const ctx = await setup()
    const path = ctx.project('中文 AI test')
    const response = await ctx.create(path)
    expect(response.status).toBe(201)
    const workspace = (await response.json()) as { id: string }
    const files = await readWorkspaceSkillFiles(path)
    expect(files.configuration.packs).toEqual([
      {
        enabled: true,
        name: 'code-janitor',
        source: { type: 'github', repository: 'zhouyuanxinand/code-janitor', ref: 'main' },
      },
      {
        enabled: true,
        name: 'matt',
        source: { type: 'github', repository: 'tt-a1i/matt-skills-with-to-goal', ref: 'main' },
      },
    ])
    expect(files.lock.packs).toMatchObject([
      {
        name: 'code-janitor',
        releaseId: ctx.janitorRelease.id,
        resolvedRevision: ctx.janitorRelease.resolvedRevision,
        contentDigest: ctx.janitorRelease.contentDigest,
        skills: [{ name: 'code-janitor', relativePath: '.' }],
      },
      {
        name: 'matt',
        releaseId: ctx.release.id,
        resolvedRevision: ctx.release.resolvedRevision,
        contentDigest: ctx.release.contentDigest,
      },
    ])
    expect(files.configuration.profiles.orchestrator).toContain('matt/to-goal')
    expect(files.configuration.profiles.coder).toContain('matt/tdd')
    expect(files.configuration.profiles.reviewer).toContain('matt/code-review')
    expect(files.configuration.profiles.tester).toContain('matt/research')
    for (const role of ['orchestrator', 'coder', 'reviewer', 'tester'] as const) {
      expect(files.configuration.profiles[role]).toContain('code-janitor/code-janitor')
    }
    for (const name of ['to-goal', 'to-spec', 'to-tickets', 'code-janitor']) {
      expect(lstatSync(join(path, '.agents', 'skills', name)).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(path, '.agents', 'skills', name, 'SKILL.md'), 'utf8')).toContain(
        `Fixture instructions for ${name}`
      )
    }
    expect(
      readFileSync(
        join(path, '.agents', 'skills', 'code-janitor', 'references', 'proof.md'),
        'utf8'
      )
    ).toBe('Prove consumers before deletion.\n')
    const inspectionResponse = await fetch(
      `${ctx.baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs`,
      { headers: { cookie: ctx.cookie } }
    )
    const inspection = (await inspectionResponse.json()) as { receipts: Array<{ state: string }> }
    expect(inspection.receipts).toMatchObject([{ state: 'applied' }, { state: 'applied' }])
    expect(ctx.store.listTerminalRuns(workspace.id)).toEqual([])
    const worker = ctx.store.addWorker(workspace.id, { name: 'Coder', role: 'coder' })
    const available = await ctx.store.skills.listForAgent(workspace.id, worker.id)
    expect(available.map((skill) => skill.qualifiedName)).toEqual(
      expect.arrayContaining(['matt/tdd', 'code-janitor/code-janitor'])
    )
  })

  test('new workspaces and a restarted runtime reuse the same locked release without downloading', async () => {
    const ctx = await setup()
    const paths = [ctx.project('first'), ctx.project('second')]
    const responses = await Promise.all(paths.map((path) => ctx.create(path)))
    expect(responses.map((response) => response.status)).toEqual([201, 201])
    await ctx.close()
    cleanup.pop()
    const restarted = await startTestServer({ dataDir: ctx.dataDir })
    cleanup.push(restarted.close)
    const cookie = await getUiCookie(restarted.baseUrl)
    const path = ctx.project('after restart')
    const response = await fetch(`${restarted.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'After restart', path, autostart_orchestrator: false }),
    })
    expect(response.status).toBe(201)
    for (const folder of [...paths, path]) {
      expect(
        (await readWorkspaceSkillFiles(folder)).lock.packs.map((pack) => pack.releaseId)
      ).toEqual([ctx.janitorRelease.id, ctx.release.id])
    }
    expect(restarted.store.listWorkspaces()).toHaveLength(3)
  })

  test('does not initialize existing workspaces or rewrite an already bound project on import', async () => {
    const ctx = await setup()
    const oldPath = ctx.project('old')
    ctx.store.createWorkspace(oldPath, 'Old workspace')
    const path = ctx.project('bound')
    expect((await ctx.create(path)).status).toBe(201)
    const configPath = join(path, '.hive', 'skill-packs.json')
    const lockPath = join(path, '.hive', 'skill-packs.lock.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    for (const pack of config.packs) pack.source.ref = 'v-custom'
    config.profiles.orchestrator = ['matt/to-spec']
    const content = JSON.stringify(config, null, 4)
    writeFileSync(configPath, content)
    const lock = readFileSync(lockPath, 'utf8')
    expect((await ctx.create(path, { name: 'Imported' })).status).toBe(201)
    expect(readFileSync(configPath, 'utf8')).toBe(content)
    expect(readFileSync(lockPath, 'utf8')).toBe(lock)
    expect(existsSync(join(oldPath, '.hive', 'skill-packs.json'))).toBe(false)
  })

  test.each([
    'matt',
    'code-janitor',
  ])('adds the missing default while preserving imported %s bindings and native links', async (packName) => {
    const ctx = await setup()
    const path = ctx.project('partially bound')
    const original = ctx.store.createWorkspace(path, 'Original')
    const release = packName === 'matt' ? ctx.release : ctx.janitorRelease
    const plan = await ctx.store.skills.plan(original.id, {
      action: 'bind',
      packName,
      releaseId: release.id,
      ...defaultSkillPackSelection(release.manifest),
    })
    await ctx.store.skills.applyPlan(original.id, plan.id)
    const before = await readWorkspaceSkillFiles(path)
    await ctx.store.deleteWorkspace(original.id)

    const response = await ctx.create(path)
    expect(response.status).toBe(201)
    const workspace = (await response.json()) as { id: string }
    const after = await readWorkspaceSkillFiles(path)
    expect(after.lock.packs).toHaveLength(2)
    expect(after.lock.packs.find((pack) => pack.name === packName)).toEqual(before.lock.packs[0])
    for (const role of ['orchestrator', 'coder', 'reviewer', 'tester'] as const) {
      expect(after.configuration.profiles[role]).toEqual(
        expect.arrayContaining(before.configuration.profiles[role])
      )
    }
    // Existing placements are reusable, not adopted: even explicit Remove must leave them alone.
    const remove = await ctx.store.skills.plan(workspace.id, { action: 'remove', packName })
    await ctx.store.skills.applyPlan(workspace.id, remove.id)
    for (const name of defaultSkillPackSelection(release.manifest).nativeExposure) {
      expect(readFileSync(join(path, '.agents', 'skills', name, 'SKILL.md'), 'utf8')).toContain(
        `Fixture instructions for ${name}`
      )
    }
  })

  test('coalesces concurrent duplicate requests including skill initialization', async () => {
    const ctx = await setup()
    const path = ctx.project('concurrent')
    const responses = await Promise.all(Array.from({ length: 4 }, () => ctx.create(path)))
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201])
    const workspaces = await Promise.all(responses.map((response) => response.json()))
    expect(new Set(workspaces.map((workspace) => workspace.id)).size).toBe(1)
    expect(ctx.store.listWorkspaces()).toHaveLength(1)
    expect((await readWorkspaceSkillFiles(path)).lock.packs).toHaveLength(2)
  })

  test('preserves a disabled Janitor alias and custom ref while adding Matt', async () => {
    const ctx = await setup()
    const path = ctx.project('custom Janitor')
    const original = ctx.store.createWorkspace(path, 'Original')
    const plan = await ctx.store.skills.plan(original.id, {
      action: 'bind',
      packName: 'cleanup',
      releaseId: ctx.janitorRelease.id,
      profiles: {},
      nativeExposure: [],
    })
    await ctx.store.skills.applyPlan(original.id, plan.id)
    const configPath = join(path, '.hive', 'skill-packs.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.packs[0].enabled = false
    config.packs[0].source.ref = 'v-custom'
    writeFileSync(configPath, JSON.stringify(config))
    const before = await readWorkspaceSkillFiles(path)
    await ctx.store.deleteWorkspace(original.id)

    expect((await ctx.create(path)).status).toBe(201)
    const after = await readWorkspaceSkillFiles(path)
    expect(after.configuration.packs.map((pack) => pack.name)).toEqual(['cleanup', 'matt'])
    expect(after.configuration.packs[0]).toEqual(before.configuration.packs[0])
    expect(after.lock.packs[0]).toEqual(before.lock.packs[0])
    expect(after.configuration.profiles.orchestrator).not.toContain('cleanup/code-janitor')
    expect(existsSync(join(path, '.agents', 'skills', 'code-janitor'))).toBe(false)
  })

  test('rejects a Janitor Pack name occupied by another source without changing project files', async () => {
    const ctx = await setup()
    const path = ctx.project('name conflict')
    const original = ctx.store.createWorkspace(path, 'Original')
    const plan = await ctx.store.skills.plan(original.id, {
      action: 'bind',
      packName: 'code-janitor',
      releaseId: ctx.release.id,
      profiles: {},
      nativeExposure: [],
    })
    await ctx.store.skills.applyPlan(original.id, plan.id)
    const before = await readWorkspaceSkillFiles(path)
    await ctx.store.deleteWorkspace(original.id)

    const response = await ctx.create(path)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error_code: 'invalid_intent' })
    expect(await readWorkspaceSkillFiles(path)).toEqual(before)
    expect(ctx.store.listWorkspaces()).toEqual([])
  })

  test.each([
    'matt',
    'code-janitor',
  ])('rejects a default %s release missing its required Skill before writing anything', async (packName) => {
    const ctx = await setup()
    const path = ctx.project('missing Skill')
    const resolvePack = ctx.store.skills.resolvePack
    vi.spyOn(ctx.store.skills, 'resolvePack').mockImplementation(async (input, options) => {
      const release = await resolvePack(input, options)
      return input.packName === packName
        ? { ...release, manifest: { ...release.manifest, skills: [] } }
        : release
    })
    const response = await ctx.create(path)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error_code: 'release_unavailable' })
    expect(existsSync(join(path, '.hive', 'skill-packs.json'))).toBe(false)
    expect(ctx.store.listWorkspaces()).toEqual([])
  })

  test.each([
    'matt',
    'code-janitor',
  ])('a %s download failure creates no workspace and the same request can retry successfully', async (packName) => {
    const ctx = await setup()
    const path = ctx.project('offline')
    const resolvePack = ctx.store.skills.resolvePack
    const spy = vi.spyOn(ctx.store.skills, 'resolvePack').mockImplementation((input, options) => {
      if (input.packName === packName)
        throw new SkillPackResolutionError('git_failed', 'Network unavailable')
      return resolvePack(input, options)
    })
    const failed = await ctx.create(path)
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({
      error_code: 'git_failed',
      error: expect.stringContaining('Network unavailable'),
    })
    expect(ctx.store.listWorkspaces()).toEqual([])
    expect(existsSync(join(path, '.hive', 'skill-packs.json'))).toBe(false)
    spy.mockRestore()
    expect((await ctx.create(path)).status).toBe(201)
    expect(ctx.store.listWorkspaces()).toHaveLength(1)
  })

  test.each([
    'to-goal',
    'code-janitor',
  ])('a conflicting %s native directory rolls back initialization and never starts a CLI', async (skillName) => {
    const ctx = await setup()
    const path = ctx.project('conflict')
    const custom = join(path, '.agents', 'skills', skillName)
    mkdirSync(custom, { recursive: true })
    writeFileSync(join(custom, 'SKILL.md'), 'User owned')
    const response = await ctx.create(path, { autostart_orchestrator: true })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error_code: 'placement_conflict' })
    expect(readFileSync(join(custom, 'SKILL.md'), 'utf8')).toBe('User owned')
    expect(ctx.store.listWorkspaces()).toEqual([])
    expect(existsSync(join(path, '.hive', 'skill-packs.lock.json'))).toBe(false)
    expect(existsSync(join(path, '.hive', 'skill-packs.json'))).toBe(false)
    expect(existsSync(join(path, '.agents', 'skills', 'to-spec'))).toBe(false)
    rmSync(custom, { recursive: true })
    expect((await ctx.create(path)).status).toBe(201)
    expect((await readWorkspaceSkillFiles(path)).lock.packs).toHaveLength(2)
  })

  test.each([
    'matt',
    'code-janitor',
  ])('rejects tampered cached %s instructions instead of binding them', async (packName) => {
    const ctx = await setup()
    writeFileSync(
      packName === 'matt'
        ? join(ctx.cachePath, 'to-goal', 'SKILL.md')
        : join(ctx.janitorCachePath, 'SKILL.md'),
      'tampered'
    )
    const response = await ctx.create(ctx.project('tampered'))
    expect(response.status).toBe(502)
    expect(ctx.store.listWorkspaces()).toEqual([])
  })

  test('keeps the workspace and receipt if rollback cannot safely restore the first Pack', async () => {
    const ctx = await setup()
    const path = ctx.project('rollback blocked')
    mkdirSync(join(path, '.agents', 'skills', 'code-janitor'), { recursive: true })
    vi.spyOn(ctx.store.skills, 'undoReceipt').mockRejectedValueOnce(
      new SkillPackChangeError('drift_detected', 'Files changed during rollback')
    )
    const response = await ctx.create(path, { autostart_orchestrator: true })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error_code: 'recovery_required',
      error: expect.stringContaining('Files changed during rollback'),
    })
    const workspaces = ctx.store.listWorkspaces()
    expect(workspaces).toHaveLength(1)
    const workspace = workspaces[0]
    if (!workspace) throw new Error('Recovery workspace missing')
    expect(ctx.store.listTerminalRuns(workspace.id)).toEqual([])
    expect((await readWorkspaceSkillFiles(path)).lock.packs.map((pack) => pack.name)).toEqual([
      'matt',
    ])
    expect((await ctx.store.skills.inspect(workspace.id)).receipts).toMatchObject([
      { state: 'applied' },
    ])
  })

  test('an unauthorized create request cannot write skill configuration', async () => {
    const ctx = await setup()
    const path = ctx.project('unauthorized')
    expect((await ctx.create(path, {}, '')).status).toBe(403)
    expect(existsSync(join(path, '.hive', 'skill-packs.json'))).toBe(false)
    expect(ctx.store.listWorkspaces()).toEqual([])
  })

  test('the real PTY sees both locked packs on its first instruction', async () => {
    const ctx = await setup()
    const path = ctx.project('pty')
    vi.stubEnv('HIVE_ORCHESTRATOR_COMMAND', process.execPath)
    vi.stubEnv(
      'HIVE_ORCHESTRATOR_ARGS_JSON',
      JSON.stringify([
        '-e',
        `const fs = require('node:fs'); const lock = JSON.parse(fs.readFileSync('.hive/skill-packs.lock.json', 'utf8')); lock.packs.forEach(p => console.log('DEFAULT_READY=' + p.name + ':' + p.resolved_revision)); setInterval(() => {}, 60000)`,
      ])
    )
    const response = await ctx.create(path, { autostart_orchestrator: true })
    expect(response.status).toBe(201)
    const workspace = (await response.json()) as { id: string; orchestrator_start: { ok: boolean } }
    expect(workspace.orchestrator_start.ok).toBe(true)
    await vi.waitFor(
      () => {
        const output = ctx.store.getActiveRunByAgentId(
          workspace.id,
          `${workspace.id}:orchestrator`
        )?.output
        expect(output).toContain(
          `DEFAULT_READY=code-janitor:${ctx.janitorRelease.resolvedRevision}`
        )
        expect(output).toContain(`DEFAULT_READY=matt:${ctx.release.resolvedRevision}`)
      },
      { timeout: 10_000 }
    )
  }, 20_000)
})
