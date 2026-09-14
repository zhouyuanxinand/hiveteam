import { describe, expect, it } from 'vitest'

import { createDesktopServiceEnvironment } from '../../desktop/service-environment.mjs'

describe('desktop service environment', () => {
  it('does not leak pnpm package-prefix overrides into Hive or its agents', () => {
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
