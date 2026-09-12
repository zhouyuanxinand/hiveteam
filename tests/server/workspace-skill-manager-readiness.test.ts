import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { createSkillPackChangeStore } from '../../src/server/skill-pack-change-store.js'
import { createSkillPackReleaseStore } from '../../src/server/skill-pack-release-store.js'
import { createSkillSnapshotStore } from '../../src/server/skill-snapshot-store.js'
import { applySchemaVersion34 } from '../../src/server/sqlite-schema-v34.js'
import { applySchemaVersion35 } from '../../src/server/sqlite-schema-v35.js'
import { applySchemaVersion36 } from '../../src/server/sqlite-schema-v36.js'
import type { TeamSkillRuntime } from '../../src/server/team-skill-runtime.js'
import { createWorkspaceSkillManager } from '../../src/server/workspace-skill-manager.js'
import type { SkillChangeOperation } from '../../src/shared/skill-packs.js'
import type { AgentSummary } from '../../src/shared/types.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('Workspace Skill Manager readiness', () => {
  test('requires a Codex restart when native exposure changes in the run start millisecond', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-skill-manager-readiness-'))
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(root)

    const db = new Database(':memory:')
    applySchemaVersion34(db)
    applySchemaVersion35(db)
    applySchemaVersion36(db)
    const changeStore = createSkillPackChangeStore(db)
    const operation: SkillChangeOperation = {
      afterFingerprint: 'link:after',
      beforeFingerprint: 'missing',
      kind: 'create_placement',
      path: join(workspacePath, '.agents', 'skills', 'to-goal'),
      skillName: 'to-goal',
    }
    const plan = changeStore.savePlan({
      action: 'update',
      beforeFingerprint: 'sha256:before',
      intent: {
        action: 'update',
        nativeExposure: ['to-goal'],
        packName: 'matt',
        profiles: {},
        releaseId: 'release-1',
      },
      internalOperations: [],
      observedFiles: [],
      observedLinks: [],
      operations: [operation],
      workspaceId: 'workspace-1',
    })
    const attempt = changeStore.beginAttempt(plan)
    changeStore.commitApply(plan, attempt.attemptId, [])
    const receipt = changeStore.getReceipt('workspace-1', attempt.attemptId)
    expect(receipt?.completedAt).not.toBeNull()
    const activeRunStartedAt = receipt?.completedAt ?? 0
    const agent: AgentSummary = {
      description: '',
      id: 'worker-1',
      name: 'Alice',
      pendingTaskCount: 0,
      role: 'coder',
      status: 'working',
      workspaceId: 'workspace-1',
    }
    const unused = async (): Promise<never> => {
      throw new Error('Unexpected Team Skill Runtime call')
    }
    const teamSkillRuntime = {
      assertLaunchReady: async () => ({
        catalog: [],
        nativeDiscovery: 'prompt_only' as const,
        nativeError: null,
      }),
      getDispatchActivation: () => null,
      listAvailable: async () => [],
      loadForAgent: unused,
      readDispatchReference: unused,
      resolveDispatchActivation: unused,
    } as TeamSkillRuntime
    const manager = createWorkspaceSkillManager({
      changeStore,
      getActiveRunStartedAt: () => activeRunStartedAt,
      getCommandPresetId: () => 'codex',
      getWorkspace: () => ({ agents: [agent], summary: { path: workspacePath } }),
      homePath: join(root, 'home'),
      releaseStore: createSkillPackReleaseStore(db),
      snapshotStore: createSkillSnapshotStore(db),
      teamSkillRuntime,
    })

    const inspection = await manager.inspect('workspace-1')

    expect(inspection.members).toContainEqual(
      expect.objectContaining({
        agentId: agent.id,
        nativeDiscoveryStatus: 'restart_required',
        restartRequired: true,
      })
    )
    db.close()
  })
})
