import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createVersionService } from '../../src/server/version-service.js'

const repositoryVersion = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version

afterEach(() => {
  vi.restoreAllMocks()
})

describe('local version service', () => {
  test('returns repository-local metadata without contacting a registry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const service = createVersionService()

    await expect(service.getVersionInfo()).resolves.toEqual({
      current_version: repositoryVersion,
      install_hint: 'npm install -g hiveteam@latest',
      latest_version: repositoryVersion,
      package_name: 'hiveteam',
      release_url: 'https://github.com/zhouyuanxinand/hiveteam',
      update_available: false,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
