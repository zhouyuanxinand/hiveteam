import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const tempDirs: string[] = []

const waitFor = async (assertion: () => void, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
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

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  for (const directory of tempDirs.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe('workspace workflows route', () => {
  test('discovers local workflow files and returns an empty catalog when the folder is absent', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const emptyRoot = mkdtempSync(join(tmpdir(), 'hiveteam-workflows-empty-'))
    tempDirs.push(emptyRoot)
    const emptyWorkspace = server.store.createWorkspace(emptyRoot, 'Empty')
    const emptyResponse = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${emptyWorkspace.id}/workflows`,
      { headers: { cookie } }
    )
    expect(emptyResponse.status).toBe(200)
    await expect(emptyResponse.json()).resolves.toEqual({ runs: [], schedules: [], workflows: [] })

    const workspaceRoot = mkdtempSync(join(tmpdir(), 'hiveteam-workflows-'))
    tempDirs.push(workspaceRoot)
    const workflowRoot = join(workspaceRoot, '.hive', 'workflows')
    mkdirSync(workflowRoot, { recursive: true })
    writeFileSync(
      join(workflowRoot, 'release-check.ts'),
      [
        "export const meta = { name: 'Release check', description: 'Validate a release build' }",
        'export default async () => ({ ok: true })',
      ].join('\n')
    )
    const workspace = server.store.createWorkspace(workspaceRoot, 'Workflows')

    const response = await fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/workflows`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      runs: [],
      schedules: [],
      workflows: [
        expect.objectContaining({
          description: 'Validate a release build',
          id: 'release-check.ts',
          name: 'Release check',
          path: '.hive/workflows/release-check.ts',
          runnable: false,
          updated_at: expect.any(Number),
        }),
      ],
    })
  })

  test('runs a safe JSON workflow in dependency order and advances from worker reports', async () => {
    const server = await startTestServer()
    servers.push(server)
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'hiveteam-workflow-run-'))
    tempDirs.push(workspaceRoot)
    const workflowRoot = join(workspaceRoot, '.hive', 'workflows')
    mkdirSync(workflowRoot, { recursive: true })
    writeFileSync(
      join(workflowRoot, 'release.json'),
      JSON.stringify({
        description: 'Build and review a release',
        name: 'Release',
        steps: [
          { id: 'build', task: 'Build the release artifact.', worker: 'Builder' },
          {
            id: 'review',
            needs: ['build'],
            task: 'Review the release artifact and report any blockers.',
            worker: 'Reviewer',
          },
        ],
      })
    )
    const workspace = server.store.createWorkspace(workspaceRoot, 'Workflow run')
    const builder = server.store.addWorker(workspace.id, { name: 'Builder', role: 'coder' })
    const reviewer = server.store.addWorker(workspace.id, { name: 'Reviewer', role: 'reviewer' })
    const launchConfig = { args: ['-e', 'process.stdin.resume()'], command: process.execPath }
    server.store.configureAgentLaunch(workspace.id, builder.id, launchConfig)
    server.store.configureAgentLaunch(workspace.id, reviewer.id, launchConfig)
    const cookie = await getUiCookie(server.baseUrl)

    const startResponse = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/workflows/runs`,
      {
        body: JSON.stringify({ workflow_id: 'release.json' }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      }
    )
    expect(startResponse.status).toBe(201)
    const started = (await startResponse.json()) as {
      id: string
      status: string
      steps: Array<{ dispatch_id: string | null; id: string; status: string }>
    }
    expect(started.status).toBe('running')
    expect(started.steps).toEqual([
      expect.objectContaining({ id: 'build', dispatch_id: expect.any(String), status: 'running' }),
      expect.objectContaining({ id: 'review', dispatch_id: null, status: 'queued' }),
    ])

    const buildDispatchId = started.steps[0]?.dispatch_id
    if (!buildDispatchId) throw new Error('Expected build dispatch')
    server.store.reportTask(workspace.id, builder.id, {
      dispatchId: buildDispatchId,
      text: 'Build completed successfully.',
    })

    await waitFor(() => {
      expect(server.store.workflows.get(workspace.id, started.id)).toMatchObject({
        status: 'running',
        steps: [
          expect.objectContaining({ id: 'build', status: 'completed' }),
          expect.objectContaining({
            dispatchId: expect.any(String),
            id: 'review',
            status: 'running',
          }),
        ],
      })
    })
    const running = server.store.workflows.get(workspace.id, started.id)
    const reviewDispatchId = running?.steps.find((step) => step.id === 'review')?.dispatchId
    if (!reviewDispatchId) throw new Error('Expected review dispatch')
    server.store.reportTask(workspace.id, reviewer.id, {
      dispatchId: reviewDispatchId,
      text: 'Review completed with no blockers.',
    })

    expect(server.store.workflows.get(workspace.id, started.id)).toMatchObject({
      status: 'completed',
      steps: [
        expect.objectContaining({ id: 'build', reportText: 'Build completed successfully.' }),
        expect.objectContaining({ id: 'review', reportText: 'Review completed with no blockers.' }),
      ],
    })
  })
})
