import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  HIVE_USAGE,
  handleHiveInfoCommand,
  parseHivePort,
  runHiveCommand,
} from '../../src/cli/hive.js'
import { DEFAULT_HIVE_PORT } from '../../src/cli/hive-defaults.js'
import { HIVE_UPDATE_USAGE, runHiveUpdateCommand } from '../../src/cli/hive-update.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hive cli', () => {
  test('uses the packaged default port unless --port overrides it', () => {
    expect(parseHivePort([])).toBe(DEFAULT_HIVE_PORT)
    expect(parseHivePort(['--port', '0'])).toBe(0)
    expect(HIVE_USAGE).toContain(`default: ${DEFAULT_HIVE_PORT}`)
  })

  test('prints help without starting the runtime', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(handleHiveInfoCommand(['--help'])).toBe(true)

    expect(logSpy).toHaveBeenCalledWith(HIVE_USAGE)
  })

  test('prints package version without starting the runtime', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string

    expect(handleHiveInfoCommand(['--version'])).toBe(true)

    expect(logSpy).toHaveBeenCalledWith(version)
  })

  test('rejects unknown arguments instead of ignoring them', async () => {
    await expect(runHiveCommand(['--bogus'])).rejects.toThrow('Unknown option: --bogus')
    await expect(runHiveCommand(['--port', '0', 'extra'])).rejects.toThrow(
      'Unknown argument: extra'
    )
  })

  test('starts http server and prints listening address', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await runHiveCommand(['--port', '0'])

    try {
      expect(result.port).toBeGreaterThan(0)
      expect(logSpy).toHaveBeenCalledWith(`Hive running at http://127.0.0.1:${result.port}`)
    } finally {
      await result.close()
    }
  })
})

describe('hive update cli', () => {
  test('--help prints update usage and exits 0 without invoking npm', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const code = await runHiveUpdateCommand(['--help'])

    expect(code).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(HIVE_UPDATE_USAGE)
  })

  test('does not contact npm and explains the source-controlled update path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const code = await runHiveUpdateCommand([])

    expect(code).toBe(0)
    expect(logSpy).toHaveBeenCalledWith('Automatic updates are disabled in this self-hosted build.')
    expect(logSpy).toHaveBeenCalledWith(
      'Pull source changes from https://github.com/zhouyuanxinand/hiveteam and rebuild locally.'
    )
  })

  test('unknown arguments are rejected without contacting npm', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await runHiveUpdateCommand(['--bogus'])

    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Unknown argument: --bogus')
  })
})

describe('hive cli dispatch (real subprocess)', () => {
  // Pin the full chain `process.argv → src/cli/hive.ts dispatch →
  // runHiveUpdateCommand`, including the fact that the compatibility command
  // does not fall through to the runtime or invoke npm.
  test('`hive update --help` exits 0 with the disabled-update usage on stdout', async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
            'src/cli/hive.ts',
            'update',
            '--help',
          ],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        )
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', reject)
        child.on('close', (code) =>
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          })
        )
      }
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Automatic updates are disabled in this self-hosted build.')
    expect(result.stdout).toContain('hive update')
    expect(result.stdout).not.toContain('npm install')
    // Update help must NOT print the generic `hive` usage with `--port`.
    expect(result.stdout).not.toContain('--port <port>')
  })
})
