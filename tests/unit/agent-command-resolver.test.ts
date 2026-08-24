import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  assertCommandIsExecutable,
  resolveCommandPath,
  resolveSpawnCommand,
} from '../../src/server/agent-command-resolver.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('agent command resolver', () => {
  test('accepts executable commands already present on PATH', () => {
    expect(() =>
      assertCommandIsExecutable(process.execPath, process.cwd(), process.env)
    ).not.toThrow()
  })

  test('uses PATHEXT candidates and ignores extensionless files on Windows', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-command-resolver-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'agent'), 'extensionless placeholder')
    writeFileSync(join(binDir, 'agent.cmd'), '@echo off\r\n')

    const resolved = resolveCommandPath(
      'agent',
      root,
      {
        Path: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        PathExt: '.cmd;.EXE',
      },
      'win32'
    )
    expect(resolved.toLowerCase()).toBe(join(binDir, 'agent.cmd').toLowerCase())
  })

  test('does not report an extensionless Windows PATH file as an executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-command-resolver-extensionless-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'agent'), 'not a Windows executable')

    expect(() =>
      resolveCommandPath('agent', root, { Path: binDir, PathExt: '.cmd;.EXE' }, 'win32')
    ).toThrow(/CLI not found in PATH/)
  })

  test('discovers a Windows CLI in common per-user install directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-command-discovery-'))
    tempDirs.push(root)
    const installDir = join(root, 'Programs', 'Zcode')
    const commandPath = join(installDir, 'zcode.cmd')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(commandPath, '@echo off\r\n')

    const resolved = resolveCommandPath(
      'zcode',
      root,
      {
        LOCALAPPDATA: root,
        Path: '',
        PathExt: '.cmd;.EXE',
      },
      'win32'
    )
    expect(resolved.toLowerCase()).toBe(commandPath.toLowerCase())
  })

  test('runs an explicitly bound Node CLI script with Node', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-command-resolver-script-'))
    tempDirs.push(root)
    const scriptPath = join(root, 'zcode.cjs')
    mkdirSync(root, { recursive: true })
    writeFileSync(scriptPath, '#!/usr/bin/env node\n')

    const env = {
      Path: '',
      PathExt: '.cmd;.EXE',
    }
    expect(resolveCommandPath(scriptPath, root, env, 'win32').toLowerCase()).toBe(
      scriptPath.toLowerCase()
    )
    expect(resolveSpawnCommand(scriptPath, root, env, ['--help'], 'win32')).toEqual({
      args: [scriptPath, '--help'],
      command: process.execPath,
    })
  })

  test('does not report a packaged desktop app executable as a CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-command-resolver-desktop-app-'))
    tempDirs.push(root)
    const installDir = join(root, 'Programs', 'ZCode')
    const desktopPath = join(installDir, 'ZCode.exe')
    mkdirSync(join(installDir, 'resources'), { recursive: true })
    writeFileSync(join(installDir, 'resources', 'app.asar'), 'packaged app placeholder')
    writeFileSync(desktopPath, 'desktop placeholder')

    expect(() =>
      resolveCommandPath(
        'zcode',
        root,
        { LOCALAPPDATA: root, Path: '', PathExt: '.cmd;.EXE' },
        'win32'
      )
    ).toThrow(/desktop app executable/)
  })

  test('does not report a protected WindowsApps resource as a runnable CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-command-resolver-windowsapps-'))
    tempDirs.push(root)
    const binDir = join(root, 'WindowsApps')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'agent.exe'), 'protected placeholder')

    expect(() =>
      resolveCommandPath('agent', root, { Path: binDir, PathExt: '.cmd;.EXE' }, 'win32')
    ).toThrow(/protected WindowsApps app resource/)
  })

  test('wraps Windows command shims with cmd.exe for PTY spawn', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-command-spawn-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    const commandPath = join(binDir, 'agent.cmd')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(commandPath, '@echo off\r\n')

    const resolved = resolveSpawnCommand(
      'agent',
      root,
      {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        Path: binDir,
        PathExt: '.cmd;.EXE',
      },
      ['--flag', 'value with spaces'],
      'win32'
    )

    expect(resolved).toEqual({
      args: `/d /s /c chcp 65001 >nul && call ${commandPath} --flag "value with spaces"`,
      command: 'C:\\Windows\\System32\\cmd.exe',
    })
  })

  test('preserves a raw Windows startup command for node-pty', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-command-shell-'))
    tempDirs.push(root)
    const commandPath = join(root, 'cmd.exe')
    writeFileSync(commandPath, 'placeholder')

    expect(
      resolveSpawnCommand(
        commandPath,
        root,
        { Path: '', PathExt: '.EXE' },
        ['/d', '/s', '/c', '"C:\\Program Files\\Agent\\agent.cmd" --model fast'],
        'win32'
      )
    ).toEqual({
      args: '/d /s /c "C:\\Program Files\\Agent\\agent.cmd" --model fast',
      command: commandPath,
    })
  })
})
