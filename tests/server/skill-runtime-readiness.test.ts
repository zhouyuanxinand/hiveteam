import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'
import type { TeamSkillRuntimeError } from '../../src/server/team-skill-runtime.js'
import { createRecordingAgentManager } from '../helpers/recording-agent-manager.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []
const IO_TIMEOUT_MS = process.platform === 'win32' ? 45_000 : 10_000
const TEST_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 15_000

const within = async <T>(
  label: string,
  promise: Promise<T>,
  timeoutMs = IO_TIMEOUT_MS
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const writeSkill = (sourcePath: string, name = 'tdd') => {
  const skillPath = join(sourcePath, 'skills', name)
  mkdirSync(join(skillPath, 'references'), { recursive: true })
  writeFileSync(
    join(skillPath, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} profile Skill.\n---\nPINNED ${name} INSTRUCTIONS`
  )
  writeFileSync(join(skillPath, 'references', 'guide.md'), `${name} reference`)
}

const bindPack = async (
  store: ReturnType<typeof createRuntimeStore>,
  workspaceId: string,
  sourcePath: string,
  nativeExposure: string[] = []
) => {
  const release = await within(
    'resolve Pack release',
    store.skills.resolvePack({
      packName: 'matt',
      source: { path: sourcePath, type: 'local' },
    })
  )
  const plan = await within(
    'create Pack plan',
    store.skills.plan(workspaceId, {
      action: 'bind',
      nativeExposure,
      packName: 'matt',
      profiles: { coder: ['tdd'], orchestrator: ['tdd'] },
      releaseId: release.id,
    })
  )
  await within('apply Pack plan', store.skills.applyPlan(workspaceId, plan.id))
  return release
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

describe('Skill runtime readiness', () => {
  test(
    'blocks PTY spawn when the immutable release cache has drifted',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-launch-drift-'))
      const workspacePath = join(dataDir, 'workspace')
      const sourcePath = join(dataDir, 'source')
      mkdirSync(workspacePath, { recursive: true })
      writeSkill(sourcePath)
      tempDirs.push(dataDir)

      const recording = createRecordingAgentManager()
      const store = createRuntimeStore({ agentManager: recording.manager, dataDir })
      stores.push(store)
      const workspace = store.createWorkspace(workspacePath, 'Launch drift')
      const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
      store.configureAgentLaunch(workspace.id, worker.id, { command: 'custom-agent' })
      const release = await bindPack(store, workspace.id, sourcePath)
      writeFileSync(
        join(dataDir, 'skill-packs', 'cache', release.cacheKey, 'skills', 'tdd', 'SKILL.md'),
        'tampered'
      )

      const inspection = await store.skills.inspect(workspace.id)
      const workerInspection = inspection.members.find((member) => member.agentId === worker.id)
      expect(workerInspection).toMatchObject({
        deliveryStatus: 'failed',
        nativeDiscoveryStatus: 'unverified',
      })
      expect(workerInspection?.error).toContain('Locked release is unavailable')

      await expect(
        store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
      ).rejects.toMatchObject({
        code: 'cache_drift',
        name: 'TeamSkillRuntimeError',
      } satisfies Partial<TeamSkillRuntimeError>)
      expect(recording.getStartCount()).toBe(0)
      expect(store.getAgent(workspace.id, worker.id).status).toBe('stopped')
    },
    TEST_TIMEOUT_MS
  )

  test(
    'falls back to prompt delivery when a Codex native placement has drifted',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-native-fallback-'))
      const workspacePath = join(dataDir, 'workspace')
      const sourcePath = join(dataDir, 'source')
      mkdirSync(workspacePath, { recursive: true })
      writeSkill(sourcePath)
      tempDirs.push(dataDir)

      const recording = createRecordingAgentManager()
      const store = createRuntimeStore({ agentManager: recording.manager, dataDir })
      stores.push(store)
      const workspace = store.createWorkspace(workspacePath, 'Native fallback')
      const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
      store.configureAgentLaunch(workspace.id, worker.id, {
        command: 'codex',
        commandPresetId: 'codex',
      })
      await bindPack(store, workspace.id, sourcePath, ['tdd'])
      rmSync(join(workspacePath, '.agents', 'skills', 'tdd'))

      const run = await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

      expect(run.status).toBe('running')
      expect(recording.getStartCount()).toBe(1)
      store.stopAgentRun(run.runId)
    },
    TEST_TIMEOUT_MS
  )

  test(
    'blocks launch when an unselected lock entry disagrees with the release',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'hive-skill-lock-drift-'))
      const workspacePath = join(dataDir, 'workspace')
      const sourcePath = join(dataDir, 'source')
      mkdirSync(workspacePath, { recursive: true })
      writeSkill(sourcePath)
      writeSkill(sourcePath, 'unused')
      tempDirs.push(dataDir)

      const recording = createRecordingAgentManager()
      const store = createRuntimeStore({ agentManager: recording.manager, dataDir })
      stores.push(store)
      const workspace = store.createWorkspace(workspacePath, 'Lock drift')
      const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
      store.configureAgentLaunch(workspace.id, worker.id, { command: 'custom-agent' })
      await bindPack(store, workspace.id, sourcePath)

      const lockPath = join(workspacePath, '.hive', 'skill-packs.lock.json')
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        packs: Array<{ skills: Array<{ content_digest: string; name: string }> }>
      }
      const unused = lock.packs[0]?.skills.find((skill) => skill.name === 'unused')
      if (!unused) throw new Error('Expected unselected Skill in lock')
      unused.content_digest = `sha256:${'0'.repeat(64)}`
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

      await expect(
        store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
      ).rejects.toMatchObject({ code: 'cache_drift' })
      expect(recording.getStartCount()).toBe(0)
    },
    TEST_TIMEOUT_MS
  )
})
