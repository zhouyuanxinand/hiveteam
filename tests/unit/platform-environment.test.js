import { expect, test } from 'vitest'
import { createPlatformEnvironment } from '../../scripts/platform-environment.mjs'

test('keeps configured CLI search priority while adding macOS login locations', () => {
  const base = {
    PATH: '/custom/cli:/opt/homebrew/bin:/usr/bin',
    HOME: '/Users/Example',
    TOKEN: 'inherited',
  }
  const env = createPlatformEnvironment(base, '/opt/node/bin/node', {
    platform: 'darwin',
    homeDir: '/Users/Example',
  })
  expect(env.PATH.split(':')).toEqual([
    '/custom/cli',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/opt/node/bin',
    '/usr/local/bin',
    '/Users/Example/.local/bin',
    '/Users/Example/.npm-global/bin',
    '/Users/Example/Library/pnpm',
    '/Users/Example/.volta/bin',
    '/Users/Example/.cargo/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ])
  expect(env.TOKEN).toBe('inherited')
  expect(base.PATH).toBe('/custom/cli:/opt/homebrew/bin:/usr/bin')
})

test('normalizes Windows Path keys and duplicates without changing directory priority', () => {
  const env = createPlatformEnvironment(
    { Path: 'D:\\Custom CLI;C:\\Node', PATH: 'c:\\node;C:\\Windows' },
    'C:\\Node\\node.exe',
    { platform: 'win32' }
  )
  expect(Object.keys(env)).toEqual(['PATH'])
  expect(env.PATH.split(';')).toEqual(['D:\\Custom CLI', 'C:\\Node', 'C:\\Windows'])
})

test('supplies system tools and user CLI directories with an empty macOS login PATH', () => {
  const env = createPlatformEnvironment({}, '/usr/local/bin/node', {
    platform: 'darwin',
    homeDir: '/Users/测试 用户',
  })
  expect(env.PATH.split(':')).toEqual([
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/Users/测试 用户/.local/bin',
    '/Users/测试 用户/.npm-global/bin',
    '/Users/测试 用户/Library/pnpm',
    '/Users/测试 用户/.volta/bin',
    '/Users/测试 用户/.cargo/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ])
})

test('preserves case-sensitive environment keys on other platforms', () => {
  expect(
    createPlatformEnvironment({ Path: 'unrelated', PATH: '/usr/bin' }, '/opt/node/node', {
      platform: 'linux',
    })
  ).toEqual({ Path: 'unrelated', PATH: '/usr/bin:/opt/node' })
})
