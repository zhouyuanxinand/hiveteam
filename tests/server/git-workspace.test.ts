import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createGitTurnCoordinator } from '../../src/server/git-turn-coordinator.js'
import type { GitWorkspaceService } from '../../src/server/git-workspace-service.js'
import { createPtyOutputBus } from '../../src/server/pty-output-bus.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import type { WorkspaceStore } from '../../src/server/workspace-store-contract.js'
import type { WorkspaceGitStatus } from '../../src/shared/git.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []
const originalGitCeilingDirectories = process.env.GIT_CEILING_DIRECTORIES

beforeAll(() => {
  const separator = process.platform === 'win32' ? ';' : ':'
  process.env.GIT_CEILING_DIRECTORIES = [tmpdir(), originalGitCeilingDirectories]
    .filter(Boolean)
    .join(separator)
})

afterAll(() => {
  if (originalGitCeilingDirectories === undefined) {
    delete process.env.GIT_CEILING_DIRECTORIES
  } else {
    process.env.GIT_CEILING_DIRECTORIES = originalGitCeilingDirectories
  }
})

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

const runGit = (cwd: string, args: string[]) => {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true })
}

const createRepository = () => {
  const repository = mkdtempSync(join(tmpdir(), 'hive-git-workspace-'))
  tempDirs.push(repository)
  runGit(repository, ['init'])
  runGit(repository, ['config', 'user.name', 'HiveTest'])
  runGit(repository, ['config', 'user.email', 'hive-test@example.test'])
  writeFileSync(join(repository, 'README.md'), '# Hive test\n')
  runGit(repository, ['add', '-A'])
  runGit(repository, ['commit', '-m', 'initial'])
  return repository
}

const readyStatus = (headSha: string): WorkspaceGitStatus => ({
  autoSnapshotEnabled: true,
  branch: 'main',
  changedFileCount: 0,
  checkedAt: Date.now(),
  error: null,
  headSha,
  isDirty: false,
  relativePath: null,
  repoRoot: '/tmp/hive-test',
  stagedFileCount: 0,
  state: 'ready',
  untrackedFileCount: 0,
  workspaceId: 'workspace-1',
  workspacePath: '/tmp/hive-test',
})

describe('Git workspace service', () => {
  test('detects a repository, records a snapshot, lists it, and reverts it safely', async () => {
    const repository = createRepository()
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-git-data-'))
    tempDirs.push(dataDir)
    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(repository, 'Git test')

    const initialStatus = await store.git.getStatus(workspace.id, repository)
    expect(initialStatus.state).toBe('ready')
    expect(initialStatus.isDirty).toBe(false)

    writeFileSync(join(repository, 'README.md'), '# Hive snapshot\n')
    const snapshot = await store.git.createSnapshot({
      message: 'HiveTeam: test snapshot',
      turnId: 'turn-1',
      workspaceId: workspace.id,
      workspacePath: repository,
    })

    expect(snapshot.outcome).toBe('created')
    expect(snapshot.commit?.isHiveTeamSnapshot).toBe(true)
    expect(snapshot.commit?.changedFiles).toBe(1)

    const history = await store.git.listCommits(workspace.id, repository)
    expect(history.commits[0]?.sha).toBe(snapshot.commit?.sha)
    expect(history.commits[0]?.turnId).toBe('turn-1')

    const reverted = await store.git.revertSnapshot({
      commitSha: snapshot.commit?.sha ?? '',
      expectedHead: snapshot.commit?.sha,
      workspaceId: workspace.id,
      workspacePath: repository,
    })
    expect(reverted.revertedSha).toBe(snapshot.commit?.sha)
    expect(readFileSync(join(repository, 'README.md'), 'utf8').replace(/\r\n/gu, '\n')).toBe(
      '# Hive test\n'
    )
    expect((await store.git.getStatus(workspace.id, repository)).isDirty).toBe(false)
  })

  test('reports a folder without Git as not-repository', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'hive-no-git-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-no-git-data-'))
    tempDirs.push(folder, dataDir)
    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(folder, 'No Git')

    const status = await store.git.getStatus(workspace.id, folder)
    expect(status.state).toBe('not-repository')
    expect(status.autoSnapshotEnabled).toBe(true)
  })
})

describe('Git turn coordinator', () => {
  test('snapshots only after an Orchestrator prompt returns', async () => {
    vi.useFakeTimers()
    try {
      const outputBus = createPtyOutputBus()
      const git = {
        createSnapshot: vi.fn(async () => ({
          changedFiles: 1,
          commit: null,
          deletions: 0,
          insertions: 1,
          outcome: 'created' as const,
        })),
        getStatus: vi.fn(async () => readyStatus('head-1')),
      } as unknown as GitWorkspaceService
      const workspaceStore = {
        getWorkspaceSnapshot: vi.fn(() => ({
          agents: [],
          autoResumeOnRestart: true,
          summary: {
            createdAt: Date.now(),
            id: 'workspace-1',
            name: 'Test',
            path: '/tmp/hive-test',
          },
        })),
      } as unknown as WorkspaceStore
      const coordinator = createGitTurnCoordinator({ git, outputBus, workspaceStore })
      coordinator.attach({
        agentId: 'workspace-1:orchestrator',
        command: 'codex',
        initialOutput: '❯ ',
        runId: 'run-1',
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/hive-test',
      })

      coordinator.recordInput('workspace-1', 'workspace-1:orchestrator', 'inspect the project')
      outputBus.publish('run-1', 'Working…\r\n❯ ')
      await vi.advanceTimersByTimeAsync(1500)

      expect(git.createSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedHead: 'head-1',
          message: expect.stringContaining('HiveTeam: Orchestrator turn'),
          turnId: expect.any(String),
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
