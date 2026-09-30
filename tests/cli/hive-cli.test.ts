import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  HIVE_USAGE,
  handleHiveInfoCommand,
  parseHivePort,
  runHiveCommand,
} from '../../src/cli/hive.js'
import { DEFAULT_HIVE_PORT } from '../../src/cli/hive-defaults.js'
import { HIVE_UPDATE_USAGE } from '../../src/cli/hive-update.js'

let testDataDir = ''

beforeEach(() => {
  testDataDir = mkdtempSync(join(tmpdir(), 'hive-cli-test-'))
  process.env.HIVE_DATA_DIR = testDataDir
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.HIVE_DATA_DIR
  if (testDataDir) rmSync(testDataDir, { force: true, recursive: true })
  testDataDir = ''
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
      expect(logSpy).toHaveBeenCalledWith(`HiveTeam running at http://127.0.0.1:${result.port}`)
    } finally {
      await result.close()
    }
  })
})

const runHiveCli = (argv: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/cli/hive.ts', ...argv],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        // tsx launches another Node process, so suppress its experimental SQLite
        // warning through the environment while still checking CLI error output.
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
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
  })

describe('hive update cli (real subprocess)', () => {
  test.each(['--help', '-h'])('`hive update %s` prints upgrade usage and exits 0', async (flag) => {
    const result = await runHiveCli(['update', flag])

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(HIVE_UPDATE_USAGE)
    expect(result.stdout).toContain('npm install -g hiveteam@latest')
    expect(result.stdout).toContain('npx --yes hiveteam@latest')
    expect(result.stderr).toBe('')
    expect(readdirSync(testDataDir)).toEqual([])
  })

  test('prints npm and source upgrade instructions without starting the runtime', async () => {
    const result = await runHiveCli(['update'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('npm install -g hiveteam@latest')
    expect(result.stdout).toContain('Then restart HiveTeam:\n  hive')
    expect(result.stdout).toContain('npx --yes hiveteam@latest')
    expect(result.stdout).toContain('git pull\n  pnpm install --frozen-lockfile\n  pnpm build')
    expect(result.stderr).toBe('')
    expect(readdirSync(testDataDir)).toEqual([])
  })

  test('rejects unknown arguments with exit code 1 and usage on stderr', async () => {
    const result = await runHiveCli(['update', '--bogus'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Unknown argument: --bogus')
    expect(result.stderr).toContain(HIVE_UPDATE_USAGE)
    expect(readdirSync(testDataDir)).toEqual([])
  })
})
