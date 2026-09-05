import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const tempDirs: string[] = []
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
  while (servers.length > 0) await servers.pop()?.close()
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

const runGit = (cwd: string, args: string[]) => {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true })
}

const createRepository = () => {
  const repository = mkdtempSync(join(tmpdir(), 'hive-dispatch-diff-'))
  tempDirs.push(repository)
  runGit(repository, ['init'])
  runGit(repository, ['config', 'user.name', 'HiveTest'])
  runGit(repository, ['config', 'user.email', 'hive-test@example.test'])
  writeFileSync(join(repository, 'README.md'), '# before\n')
  runGit(repository, ['add', '-A'])
  runGit(repository, ['commit', '-m', 'initial'])
  return repository
}

const diffUrl = (
  server: Awaited<ReturnType<typeof startTestServer>>,
  workspaceId: string,
  dispatchId: string
) => `${server.baseUrl}/api/ui/workspaces/${workspaceId}/dispatches/${dispatchId}/diff`

describe('GET /api/ui/workspaces/:workspaceId/dispatches/:dispatchId/diff', () => {
  test('captures a baseline at dispatch time and returns the working-tree patch', async () => {
    const repository = createRepository()
    const server = await startTestServer()
    servers.push(server)
    const workspace = server.store.createWorkspace(repository, 'Diff review')
    const worker = server.store.addWorker(workspace.id, {
      description: 'Implements changes.',
      name: 'Coder',
      role: 'coder',
    })

    const dispatch = await server.store.dispatchTask(workspace.id, worker.id, 'Update the readme')
    const baselineSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
    expect(dispatch.baseHeadSha).toBe(baselineSha)

    writeFileSync(join(repository, 'README.md'), '# after\n')
    writeFileSync(join(repository, 'notes.txt'), 'untracked\n')

    const cookie = await getUiCookie(server.baseUrl)
    const response = await fetch(diffUrl(server, workspace.id, dispatch.id), {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      base_head_sha: string
      dispatch_id: string
      head_sha: string | null
      patch: string
      truncated: boolean
      untracked_files: string[]
    }
    expect(body.dispatch_id).toBe(dispatch.id)
    expect(body.base_head_sha).toBe(baselineSha)
    expect(body.head_sha).toBe(baselineSha)
    expect(body.truncated).toBe(false)
    expect(body.patch).toContain('-# before')
    expect(body.patch).toContain('+# after')
    expect(body.untracked_files).toEqual(['notes.txt'])

    // The dispatch listing exposes the baseline so the UI can offer review.
    const listResponse = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/dispatches`,
      { headers: { cookie } }
    )
    expect(listResponse.status).toBe(200)
    const dispatches = (await listResponse.json()) as Array<{
      base_head_sha: string | null
      id: string
    }>
    expect(dispatches).toEqual([
      expect.objectContaining({ base_head_sha: baselineSha, id: dispatch.id }),
    ])
  })

  test('rejects unauthenticated requests', async () => {
    const repository = createRepository()
    const server = await startTestServer()
    servers.push(server)
    const workspace = server.store.createWorkspace(repository, 'Diff review')
    const worker = server.store.addWorker(workspace.id, {
      description: 'Implements changes.',
      name: 'Coder',
      role: 'coder',
    })
    const dispatch = await server.store.dispatchTask(workspace.id, worker.id, 'Update the readme')

    const response = await fetch(diffUrl(server, workspace.id, dispatch.id))
    expect(response.status).toBe(403)
  })

  test('returns 404 for an unknown dispatch and 409 when no baseline exists', async () => {
    const server = await startTestServer()
    servers.push(server)
    // server.dataDir is not a Git repository, so the dispatch records no
    // baseline and the review endpoint must say so explicitly.
    const workspace = server.store.createWorkspace(server.dataDir, 'No git')
    const worker = server.store.addWorker(workspace.id, {
      description: 'Implements changes.',
      name: 'Coder',
      role: 'coder',
    })
    const dispatch = await server.store.dispatchTask(workspace.id, worker.id, 'Do work')
    expect(dispatch.baseHeadSha).toBeNull()

    const cookie = await getUiCookie(server.baseUrl)
    const missing = await fetch(diffUrl(server, workspace.id, 'missing-dispatch'), {
      headers: { cookie },
    })
    expect(missing.status).toBe(404)

    const noBaseline = await fetch(diffUrl(server, workspace.id, dispatch.id), {
      headers: { cookie },
    })
    expect(noBaseline.status).toBe(409)
    const body = (await noBaseline.json()) as { error: string }
    expect(body.error).toContain('no Git baseline')
  })
})
