import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

import { describe, expect, test } from 'vitest'

interface PackFile {
  path: string
}

interface PackResult {
  files: PackFile[]
  name: string
  version: string
}

const runPackSmoke = () =>
  new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ['scripts/pack-smoke.mjs'],
      { encoding: 'utf8', timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error) {
          const output = [stdout, stderr].filter(Boolean).join('\n').trim()
          if (output) error.message = `${error.message}\n${output}`
          reject(error)
          return
        }
        if (stderr) console.warn(stderr.trim())
        resolve()
      }
    )
  })

const activeNodeDir = dirname(process.execPath)
const activeNpmCli = join(activeNodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')

const withActiveNodeEnv = (env: NodeJS.ProcessEnv = {}) => {
  const mergedEnv = { ...process.env, ...env }
  mergedEnv.PATH = [activeNodeDir, mergedEnv.PATH].filter(Boolean).join(delimiter)
  return mergedEnv
}

const runNpm = (args: string[]) => {
  const command = existsSync(activeNpmCli)
    ? { file: process.execPath, args: [activeNpmCli, ...args] }
    : process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] }
      : { file: 'npm', args }

  return execFileSync(command.file, command.args, {
    encoding: 'utf8',
    env: withActiveNodeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

describe('npm package tarball', () => {
  test('publish dry-run exposes only runtime files and the hive bin', () => {
    expect(existsSync(join(process.cwd(), 'dist', 'src', 'cli', 'hive.js'))).toBe(true)
    expect(existsSync(join(process.cwd(), 'web', 'dist', 'index.html'))).toBe(true)

    const output = runNpm(['pack', '--dry-run', '--json'])
    const [result] = JSON.parse(output) as PackResult[]
    if (!result) throw new Error('npm pack --dry-run returned no package metadata')
    const paths = result.files.map((file) => file.path)

    expect(result.name).toBe('hiveteam')
    expect(result.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    expect(paths).toContain('dist/src/cli/hive.js')
    expect(paths).toContain('dist/src/cli/team.js')
    expect(paths).toContain('dist/bin/team')
    expect(paths).toContain('dist/bin/team.cmd')
    expect(paths).toContain('web/dist/index.html')
    expect(paths).toContain('scripts/fix-runtime-artifacts.mjs')
    expect(paths).toContain('CHANGELOG.md')
    expect(paths).toContain('LICENSE')
    expect(paths).toContain('README.md')
    expect(paths).toContain('SECURITY.md')

    expect(paths.some((path) => path.startsWith('src/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('tests/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('web/src/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('dist/tests/'))).toBe(false)
    expect(paths.some((path) => path.endsWith('.map'))).toBe(false)
    expect(paths).not.toContain('AGENTS.md')
    expect(paths).not.toContain('CLAUDE.md')
    expect(paths).not.toContain('TODO.md')
    expect(paths).not.toContain('bin/team')
  })

  test('published tarball installs and starts the packaged runtime', async () => {
    await runPackSmoke()
  }, 120_000)
})
