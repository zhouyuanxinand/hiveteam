import { afterEach, describe, expect, test, vi } from 'vitest'

import { createVersionService } from '../../src/server/version-service.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('local version service', () => {
  test('returns repository-local metadata without contacting a registry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const service = createVersionService()

    await expect(service.getVersionInfo()).resolves.toEqual({
      current_version: '1.4.0',
      install_hint: 'git pull',
      latest_version: '1.4.0',
      package_name: 'hiveteam',
      release_url: 'https://github.com/zhouyuanxinand/hiveteam',
      update_available: false,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
