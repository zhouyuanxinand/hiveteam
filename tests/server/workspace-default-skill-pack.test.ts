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
import { SkillPackResolutionError } from '../../src/server/skill-pack-source.js'
import { seedDefaultSkillPackCache } from '../helpers/default-skill-pack-fixture.js'
import { startTestServer } from '../helpers/test-server.js'
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

describe('new workspace default Skill Pack', () => {
  test('binds an immutable cached Matt release, role profiles and native entry points before returning 201', async () => {
    const ctx = await setup()
    const path = ctx.project('中文 AI test')
    const response = await ctx.create(path)
    expect(response.status).toBe(201)
    const workspace = (await response.json()) as { id: string }
    const files = await readWorkspaceSkillFiles(path)
    expect(files.configuration.packs).toEqual([
      {
        enabled: true,
        name: 'matt',
        source: { type: 'github', repository: 'tt-a1i/matt-skills-with-to-goal', ref: 'main' },
      },
    ])
    expect(files.lock.packs).toMatchObject([
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
    for (const name of ['to-goal', 'to-spec', 'to-tickets']) {
      expect(lstatSync(join(path, '.agents', 'skills', name)).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(path, '.agents', 'skills', name, 'SKILL.md'), 'utf8')).toContain(
        `Fixture instructions for ${name}`
      )
    }
    const inspectionResponse = await fetch(
      `${ctx.baseUrl}/api/ui/workspaces/${workspace.id}/skill-packs`,
      { headers: { cookie: ctx.cookie } }
    )
    const inspection = (await inspectionResponse.json()) as { receipts: Array<{ state: string }> }
    expect(inspection.receipts).toMatchObject([{ state: 'applied' }])
    expect(ctx.store.listTerminalRuns(workspace.id)).toEqual([])
    const worker = ctx.store.addWorker(workspace.id, { name: 'Coder', role: 'coder' })
    const available = await ctx.store.skills.listForAgent(workspace.id, worker.id)
    expect(available.map((skill) => skill.qualifiedName)).toContain('matt/tdd')
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
      expect((await readWorkspaceSkillFiles(folder)).lock.packs[0]?.releaseId).toBe(ctx.release.id)
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
    config.packs[0].source.ref = 'v-custom'
    config.profiles.orchestrator = ['matt/to-spec']
    const content = JSON.stringify(config, null, 4)
    writeFileSync(configPath, content)
    const lock = readFileSync(lockPath, 'utf8')
    expect((await ctx.create(path, { name: 'Imported' })).status).toBe(201)
    expect(readFileSync(configPath, 'utf8')).toBe(content)
    expect(readFileSync(lockPath, 'utf8')).toBe(lock)
    expect(existsSync(join(oldPath, '.hive', 'skill-packs.json'))).toBe(false)
  })

  test('coalesces concurrent duplicate requests including skill initialization', async () => {
    const ctx = await setup()
    const path = ctx.project('concurrent')
    const responses = await Promise.all(Array.from({ length: 4 }, () => ctx.create(path)))
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201])
    const workspaces = await Promise.all(responses.map((response) => response.json()))
    expect(new Set(workspaces.map((workspace) => workspace.id)).size).toBe(1)
    expect(ctx.store.listWorkspaces()).toHaveLength(1)
    expect((await readWorkspaceSkillFiles(path)).lock.packs).toHaveLength(1)
  })

  test('a download failure creates no workspace and the same request can retry successfully', async () => {
    const ctx = await setup()
    const path = ctx.project('offline')
    vi.spyOn(ctx.store.skills, 'resolvePack').mockRejectedValueOnce(
      new SkillPackResolutionError('git_failed', 'Network unavailable')
    )
    const failed = await ctx.create(path)
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({
      error_code: 'git_failed',
      error: expect.stringContaining('Network unavailable'),
    })
    expect(ctx.store.listWorkspaces()).toEqual([])
    expect(existsSync(join(path, '.hive', 'skill-packs.json'))).toBe(false)
    expect((await ctx.create(path)).status).toBe(201)
    expect(ctx.store.listWorkspaces()).toHaveLength(1)
  })

  test('native directory conflicts preserve user files, remove the failed record, and never start a CLI', async () => {
    const ctx = await setup()
    const path = ctx.project('conflict')
    const custom = join(path, '.agents', 'skills', 'to-goal')
    mkdirSync(custom, { recursive: true })
    writeFileSync(join(custom, 'SKILL.md'), 'User owned')
    const response = await ctx.create(path, { autostart_orchestrator: true })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error_code: 'placement_conflict' })
    expect(readFileSync(join(custom, 'SKILL.md'), 'utf8')).toBe('User owned')
    expect(ctx.store.listWorkspaces()).toEqual([])
    expect(existsSync(join(path, '.hive', 'skill-packs.lock.json'))).toBe(false)
  })

  test('rejects tampered cached instructions instead of binding them', async () => {
    const ctx = await setup()
    writeFileSync(join(ctx.cachePath, 'to-goal', 'SKILL.md'), 'tampered')
    const response = await ctx.create(ctx.project('tampered'))
    expect(response.status).toBe(502)
    expect(ctx.store.listWorkspaces()).toEqual([])
  })

  test('an unauthorized create request cannot write skill configuration', async () => {
    const ctx = await setup()
    const path = ctx.project('unauthorized')
    expect((await ctx.create(path, {}, '')).status).toBe(403)
    expect(existsSync(join(path, '.hive', 'skill-packs.json'))).toBe(false)
    expect(ctx.store.listWorkspaces()).toEqual([])
  })

  test('the real PTY sees the locked pack on its first instruction', async () => {
    const ctx = await setup()
    const path = ctx.project('pty')
    vi.stubEnv('HIVE_ORCHESTRATOR_COMMAND', process.execPath)
    vi.stubEnv(
      'HIVE_ORCHESTRATOR_ARGS_JSON',
      JSON.stringify([
        '-e',
        `const fs = require('node:fs'); const lock = JSON.parse(fs.readFileSync('.hive/skill-packs.lock.json', 'utf8')); process.stdout.write('DEFAULT_PACK_READY=' + lock.packs[0].resolved_revision); setInterval(() => {}, 60000)`,
      ])
    )
    const response = await ctx.create(path, { autostart_orchestrator: true })
    expect(response.status).toBe(201)
    const workspace = (await response.json()) as { id: string; orchestrator_start: { ok: boolean } }
    expect(workspace.orchestrator_start.ok).toBe(true)
    await vi.waitFor(
      () => {
        expect(
          ctx.store.getActiveRunByAgentId(workspace.id, `${workspace.id}:orchestrator`)?.output
        ).toContain(`DEFAULT_PACK_READY=${ctx.release.resolvedRevision}`)
      },
      { timeout: 10_000 }
    )
  }, 20_000)
})
