import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'

const BRIDGE_TOKEN = 'desktop-bridge-test-token'

let directory = ''
let sandboxRoot = ''
let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-desktop-sandbox-'))
  const outsideRoot = mkdtempSync(join(tmpdir(), 'hive-desktop-drop-'))
  directory = join(outsideRoot, '项目 with spaces')
  mkdirSync(directory, { recursive: true })
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot
  process.env.HIVE_DESKTOP_BRIDGE_TOKEN = BRIDGE_TOKEN
  server = await startTestServer()
})

afterEach(async () => {
  await server.close()
  delete process.env.HIVE_DESKTOP_BRIDGE_TOKEN
  delete process.env.HIVE_FS_BROWSE_ROOT
  rmSync(sandboxRoot, { force: true, recursive: true })
  rmSync(join(directory, '..'), { force: true, recursive: true })
})

const probeDroppedFolder = (token: string | null, path: unknown = directory) =>
  fetch(`${server.baseUrl}/api/desktop/folders/probe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { 'x-hive-desktop-token': token }),
    },
    body: JSON.stringify({ path }),
  })

describe('POST /api/desktop/folders/probe', () => {
  test('probes the exact dropped directory outside the browser sandbox', async () => {
    const response = await probeDroppedFolder(BRIDGE_TOKEN)
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      exists: true,
      is_dir: true,
      ok: true,
      path: directory,
      suggested_name: '项目 with spaces',
    })
  })

  test.each([
    null,
    'wrong-token',
  ])('does not expose the bridge without its capability token', async (token) => {
    const response = await probeDroppedFolder(token)
    expect(response.status).toBe(404)
  })

  test('rejects relative paths before probing', async () => {
    const response = await probeDroppedFolder(BRIDGE_TOKEN, 'relative/project')
    expect(response.status).toBe(400)
  })
})
