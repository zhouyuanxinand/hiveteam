// @vitest-environment jsdom

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createPlatformAutostart,
  type PlatformAutostartOptions,
  type RunAutostartCommand,
} from '../../src/server/platform-autostart.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-login-start-'))
  roots.push(root)
  const projectRoot = join(root, "项目 ' & $HOME")
  const dataDir = join(root, 'saved data')
  const homeDir = join(root, 'home')
  await mkdir(join(projectRoot, 'scripts'), { recursive: true })
  await mkdir(dataDir)
  await writeFile(join(projectRoot, 'scripts', 'platform-start.mjs'), '')
  const options: PlatformAutostartOptions = {
    dataDir,
    projectRoot,
    homeDir,
    nodeExecutable: process.execPath,
    runtimePort: 9483,
    webPort: 5180,
    launchMode: 'development',
    uid: 501,
  }
  return {
    options,
    configPath: join(dataDir, 'platform-autostart', 'launch.json'),
    agents: join(homeDir, 'Library', 'LaunchAgents'),
  }
}

const launchctl = () => {
  const disabled = new Map<string, boolean>()
  let failEnable = false
  const runCommand: RunAutostartCommand = async ({ executable, args }) => {
    if (executable !== '/bin/launchctl') throw new Error('Unexpected executable')
    const [operation, target] = args
    if (operation === 'print-disabled') {
      expect(target).toBe('gui/501')
      return {
        exitCode: 0,
        stderr: '',
        stdout: `disabled services = {\n${[...disabled].map(([label, value]) => `\t"${label}" => ${value}`).join('\n')}\n}`,
      }
    }
    if (
      (operation !== 'enable' && operation !== 'disable') ||
      !target?.startsWith('gui/501/io.hiveteam.')
    )
      throw new Error('Unexpected launchctl mutation')
    if (operation === 'enable' && failEnable)
      return { exitCode: 5, stdout: '', stderr: 'Fixture denied' }
    disabled.set(target.slice('gui/501/'.length), operation === 'disable')
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return {
    disabled,
    runCommand,
    failNextEnable: () => {
      failEnable = true
    },
  }
}

const plistValues = (text: string) => {
  const document = new DOMParser().parseFromString(text, 'application/xml')
  const decode = (element: Element): unknown => {
    if (element.tagName === 'dict') {
      const children = Array.from(element.children)
      return Object.fromEntries(
        children
          .filter((_, index) => index % 2 === 0)
          .map((key, index) => {
            const value = children[index * 2 + 1]
            if (!value) throw new Error('Invalid plist pair')
            return [key.textContent, decode(value)]
          })
      )
    }
    if (element.tagName === 'array') return Array.from(element.children).map(decode)
    if (element.tagName === 'true' || element.tagName === 'false') return element.tagName === 'true'
    return element.textContent
  }
  const dict = document.querySelector('plist > dict')
  if (!dict) throw new Error('Missing plist dictionary')
  return decode(dict)
}

describe('platform login startup', () => {
  test('unsupported systems remain off without writing configuration or invoking OS commands', async () => {
    const { options, configPath } = await fixture()
    const startup = createPlatformAutostart({
      ...options,
      platform: 'linux',
      runCommand: async () => {
        throw new Error('Must not execute')
      },
    })
    expect(await startup.getStatus()).toEqual({
      supported: false,
      enabled: false,
      platform: 'linux',
      activation: 'next_login',
    })
    await expect(startup.setEnabled(true)).rejects.toThrow('not supported')
    await expect(readFile(configPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('Windows status follows Task Scheduler, preserving only the launch config whitelist', async () => {
    const { options, configPath } = await fixture()
    let registered = false
    let enabled = false
    const runCommand: RunAutostartCommand = async ({ input }) => {
      const request = JSON.parse(input ?? '{}')
      if (request.operation === 'enable') {
        registered = true
        enabled = true
      }
      if (request.operation === 'disable') enabled = false
      return { exitCode: 0, stdout: JSON.stringify({ registered, enabled }), stderr: '' }
    }
    const startup = createPlatformAutostart({ ...options, platform: 'win32', runCommand })
    expect(await startup.getStatus()).toMatchObject({ supported: true, enabled: false })
    expect(await startup.setEnabled(true)).toMatchObject({ enabled: true })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      data_dir: options.dataDir,
      project_root: options.projectRoot,
      node_executable: process.execPath,
      runtime_port: 9483,
      web_port: 5180,
      launch_mode: 'development',
    })
    enabled = false
    expect(await startup.getStatus()).toMatchObject({ enabled: false })
    expect(await startup.setEnabled(true)).toMatchObject({ enabled: true })
    expect(await startup.setEnabled(false)).toMatchObject({ enabled: false })
    expect(registered).toBe(true)
  })

  test('macOS schedules the next login and respects the system disabled state without disturbing other agents', async () => {
    const { options, agents, configPath } = await fixture()
    const os = launchctl()
    const startup = createPlatformAutostart({
      ...options,
      platform: 'darwin',
      runCommand: os.runCommand,
    })
    expect(await startup.getStatus()).toMatchObject({ enabled: false })
    await mkdir(agents, { recursive: true })
    await writeFile(join(agents, 'another-app.plist'), 'Owned by another app')
    expect(await startup.setEnabled(true)).toMatchObject({
      supported: true,
      enabled: true,
      activation: 'next_login',
    })
    const filename = (await readdir(agents)).find((name) => name.startsWith('io.hiveteam.'))
    if (!filename) throw new Error('Missing LaunchAgent')
    const label = filename.slice(0, -'.plist'.length)
    expect(plistValues(await readFile(join(agents, filename), 'utf8'))).toEqual({
      Label: label,
      ProgramArguments: [
        process.execPath,
        join(options.projectRoot, 'scripts', 'platform-start.mjs'),
        '--config',
        configPath,
      ],
      WorkingDirectory: options.projectRoot,
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      StandardOutPath: join(options.dataDir, 'platform-autostart', 'stdout.log'),
      StandardErrorPath: join(options.dataDir, 'platform-autostart', 'stderr.log'),
    })
    os.disabled.set(label, true)
    expect(await startup.getStatus()).toMatchObject({ enabled: false })
    expect(await startup.setEnabled(true)).toMatchObject({ enabled: true })
    expect(await startup.setEnabled(false)).toMatchObject({ enabled: false })
    expect(await readdir(agents)).toEqual(['another-app.plist'])
    expect(await readFile(join(agents, 'another-app.plist'), 'utf8')).toBe('Owned by another app')
    expect(os.disabled.get(label)).toBe(true)
  })

  test('a foreign launch config is rejected without changing its registration or contents', async () => {
    const { options, configPath } = await fixture()
    const os = launchctl()
    const startup = createPlatformAutostart({
      ...options,
      platform: 'darwin',
      runCommand: os.runCommand,
    })
    await startup.setEnabled(true)
    const original = JSON.parse(await readFile(configPath, 'utf8'))
    const foreign = JSON.stringify({
      ...original,
      project_root: join(options.projectRoot, 'other'),
    })
    await writeFile(configPath, foreign)
    expect(await startup.getStatus()).toMatchObject({
      enabled: false,
      error: expect.stringContaining('another project'),
    })
    await expect(startup.setEnabled(false)).rejects.toThrow('another project')
    expect(await readFile(configPath, 'utf8')).toBe(foreign)
    expect([...os.disabled.values()]).toEqual([false])
  })

  test('foreign plist changes cannot be disabled or replaced even when the label matches', async () => {
    const { options, agents } = await fixture()
    const os = launchctl()
    const startup = createPlatformAutostart({
      ...options,
      platform: 'darwin',
      runCommand: os.runCommand,
    })
    await startup.setEnabled(true)
    const filename = (await readdir(agents))[0]
    if (!filename) throw new Error('Missing LaunchAgent')
    const path = join(agents, filename)
    const foreign = (await readFile(path, 'utf8')).replace('platform-start.mjs', 'other-start.mjs')
    await writeFile(path, foreign)
    await expect(startup.setEnabled(false)).rejects.toThrow('another project')
    await expect(startup.setEnabled(true)).rejects.toThrow('another project')
    expect(await readFile(path, 'utf8')).toBe(foreign)
  })

  test('failed macOS enable removes the new plist so it cannot start at a later login', async () => {
    const { options, agents } = await fixture()
    const os = launchctl()
    os.failNextEnable()
    const startup = createPlatformAutostart({
      ...options,
      platform: 'darwin',
      runCommand: os.runCommand,
    })
    await expect(startup.setEnabled(true)).rejects.toThrow('Fixture denied')
    expect(await readdir(agents)).toEqual([])
    expect(await startup.getStatus()).toMatchObject({ enabled: false })
  })

  test('unknown launchctl output reports an error instead of assuming an enabled registration', async () => {
    const { options, configPath } = await fixture()
    const startup = createPlatformAutostart({
      ...options,
      platform: 'darwin',
      runCommand: async () => ({ exitCode: 0, stdout: 'unrecognized output', stderr: '' }),
    })
    expect(await startup.getStatus()).toMatchObject({
      enabled: false,
      error: expect.stringContaining('unrecognized'),
    })
    await expect(startup.setEnabled(true)).rejects.toThrow('unrecognized')
    await expect(readFile(configPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('concurrent toggles are serialized and the final registration matches the last request', async () => {
    const { options } = await fixture()
    const os = launchctl()
    const startup = createPlatformAutostart({
      ...options,
      platform: 'darwin',
      runCommand: os.runCommand,
    })
    const results = await Promise.all([
      startup.setEnabled(true),
      startup.setEnabled(false),
      startup.setEnabled(true),
    ])
    expect(results.map((status) => status.enabled)).toEqual([true, false, true])
    expect(await startup.getStatus()).toMatchObject({ enabled: true })
  })
})

test('macOS disable does not change an orphaned label after its owned plist disappears', async () => {
  const { options, agents } = await fixture()
  const os = launchctl()
  const startup = createPlatformAutostart({
    ...options,
    platform: 'darwin',
    runCommand: os.runCommand,
  })
  await startup.setEnabled(true)
  const filename = (await readdir(agents))[0]
  if (!filename) throw new Error('Missing LaunchAgent')
  await rm(join(agents, filename))
  expect(await startup.setEnabled(false)).toMatchObject({ enabled: false })
  expect([...os.disabled.values()]).toEqual([false])
})

test('saved launch config rejects extra environment fields instead of trusting file existence', async () => {
  const { options, configPath } = await fixture()
  const os = launchctl()
  const startup = createPlatformAutostart({
    ...options,
    platform: 'darwin',
    runCommand: os.runCommand,
  })
  await startup.setEnabled(true)
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const invalid = JSON.stringify({ ...config, environment: { HOME: '/different-home' } })
  await writeFile(configPath, invalid)
  expect(await startup.getStatus()).toMatchObject({
    enabled: false,
    error: expect.stringContaining('unsupported fields'),
  })
  await expect(startup.setEnabled(false)).rejects.toThrow('unsupported fields')
  expect(await readFile(configPath, 'utf8')).toBe(invalid)
  expect([...os.disabled.values()]).toEqual([false])
})

test.each([
  'disable',
  'update',
])('macOS recognizes the old Node registration after an upgrade (%s)', async (operation) => {
  const { options, agents, configPath } = await fixture()
  const os = launchctl()
  const startup = createPlatformAutostart({
    ...options,
    platform: 'darwin',
    runCommand: os.runCommand,
  })
  await startup.setEnabled(true)
  const upgradedNode = join(options.projectRoot, 'new node')
  await writeFile(upgradedNode, '')
  const upgraded = createPlatformAutostart({
    ...options,
    nodeExecutable: upgradedNode,
    runtimeEntry: 'source',
    platform: 'darwin',
    runCommand: os.runCommand,
  })
  expect(await upgraded.getStatus()).toMatchObject({ enabled: true })
  if (operation === 'disable') {
    expect(await upgraded.setEnabled(false)).toMatchObject({ enabled: false })
    expect(await readdir(agents)).toEqual([])
  }
  expect(await upgraded.setEnabled(true)).toMatchObject({ enabled: true })
  const filename = (await readdir(agents))[0]
  if (!filename) throw new Error('Missing upgraded LaunchAgent')
  expect(plistValues(await readFile(join(agents, filename), 'utf8'))).toMatchObject({
    ProgramArguments: [
      upgradedNode,
      join(options.projectRoot, 'scripts', 'platform-start.mjs'),
      '--config',
      configPath,
    ],
  })
  expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
    node_executable: upgradedNode,
    runtime_entry: 'source',
  })
  expect(await upgraded.getStatus()).toMatchObject({ enabled: true })
})

test('failed macOS Node upgrade restores the owned plist and saved config for later disable', async () => {
  const { options, agents, configPath } = await fixture()
  const os = launchctl()
  const startup = createPlatformAutostart({
    ...options,
    platform: 'darwin',
    runCommand: os.runCommand,
  })
  await startup.setEnabled(true)
  const filename = (await readdir(agents))[0]
  if (!filename) throw new Error('Missing LaunchAgent')
  const plistPath = join(agents, filename)
  const originalPlist = await readFile(plistPath, 'utf8')
  const originalConfig = await readFile(configPath, 'utf8')
  const upgradedNode = join(options.projectRoot, 'new node')
  await writeFile(upgradedNode, '')
  const upgraded = createPlatformAutostart({
    ...options,
    nodeExecutable: upgradedNode,
    platform: 'darwin',
    runCommand: os.runCommand,
  })
  os.failNextEnable()
  await expect(upgraded.setEnabled(true)).rejects.toThrow('Fixture denied')
  expect(await readFile(plistPath, 'utf8')).toBe(originalPlist)
  expect(await readFile(configPath, 'utf8')).toBe(originalConfig)
  expect(await upgraded.getStatus()).toMatchObject({ enabled: true })
  expect(await upgraded.setEnabled(false)).toMatchObject({ enabled: false })
})
