import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const tempDirs: string[] = []

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
          updated_at: expect.any(Number),
        }),
      ],
    })
  })
})
