import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createDesktopServiceEnvironment } from '../../desktop/service-environment.mjs'

describe('desktop service environment', () => {
  it('pins the home default when no directory is configured', () => {
    expect(createDesktopServiceEnvironment({}).HIVE_DATA_DIR).toBe(
      join(homedir(), '.config', 'hive')
    )
    expect(createDesktopServiceEnvironment({ HIVE_DATA_DIR: '' }).HIVE_DATA_DIR).toBe(
      join(homedir(), '.config', 'hive')
    )
  })

  it('resolves relative directories before spawning without mutating the parent environment', () => {
    const parentEnvironment = { HIVE_DATA_DIR: './saved data/../saved 中文' }
    expect(createDesktopServiceEnvironment(parentEnvironment).HIVE_DATA_DIR).toBe(
      resolve(parentEnvironment.HIVE_DATA_DIR)
    )
    expect(parentEnvironment.HIVE_DATA_DIR).toBe('./saved data/../saved 中文')
  })

  it('honors explicit directories and lets the launch option override the inherited directory', () => {
    const directory = resolve('custom data')
    expect(createDesktopServiceEnvironment({ HIVE_DATA_DIR: directory }).HIVE_DATA_DIR).toBe(
      directory
    )
    expect(
      createDesktopServiceEnvironment(
        { HIVE_DATA_DIR: directory },
        {
          HIVE_DATA_DIR: './acceptance data',
        }
      ).HIVE_DATA_DIR
    ).toBe(resolve('acceptance data'))
  })

  it('does not leak pnpm package-prefix overrides into HiveTeam or its agents', () => {
    const parentEnvironment = {
      PATH: 'D:\\Dev\\npm-global',
      npm_config_cache: 'D:\\Dev\\npm-cache',
      npm_config_prefix: 'D:\\repo\\desktop',
      npm_config_registry: 'https://registry.example.test',
    }

    const environment = createDesktopServiceEnvironment(parentEnvironment, {
      HIVE_RUNTIME_PORT: '4010',
    })

    expect(environment).not.toHaveProperty('npm_config_prefix')
    expect(environment).toMatchObject({
      HIVE_RUNTIME_PORT: '4010',
      PATH: 'D:\\Dev\\npm-global',
      npm_config_cache: 'D:\\Dev\\npm-cache',
      npm_config_registry: 'https://registry.example.test',
    })
    expect(parentEnvironment.npm_config_prefix).toBe('D:\\repo\\desktop')
  })

  it('removes differently-cased prefix keys without dropping unrelated npm settings', () => {
    const environment = createDesktopServiceEnvironment({
      NPM_CONFIG_PREFIX: '/repo/desktop',
      NPM_CONFIG_USERCONFIG: '/home/test/.npmrc',
    })

    expect(environment).not.toHaveProperty('NPM_CONFIG_PREFIX')
    expect(environment.NPM_CONFIG_USERCONFIG).toBe('/home/test/.npmrc')
  })
})
