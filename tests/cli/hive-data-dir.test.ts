import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { resolveDataDir } from '../../src/cli/hive-data-dir.js'

afterEach(() => vi.unstubAllEnvs())

describe('CLI data directory', () => {
  test.each([
    undefined,
    '',
  ])('keeps the home default for an unset or empty override (%s)', (value) => {
    vi.stubEnv('HIVE_DATA_DIR', value)
    expect(resolveDataDir()).toBe(join(homedir(), '.config', 'hive'))
  })

  test('normalizes a relative override without changing the caller environment', () => {
    const override = './saved data/../saved 中文'
    vi.stubEnv('HIVE_DATA_DIR', override)
    expect(resolveDataDir()).toBe(resolve(override))
    expect(process.env.HIVE_DATA_DIR).toBe(override)
  })

  test('honors an absolute override independently of the default', () => {
    const override = resolve('custom data')
    vi.stubEnv('HIVE_DATA_DIR', override)
    expect(resolveDataDir()).toBe(override)
  })
})
