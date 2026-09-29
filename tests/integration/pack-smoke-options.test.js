import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, test } from 'vitest'

const cli = fileURLToPath(new URL('../../scripts/pack-smoke.mjs', import.meta.url))
const temporaryRoots = []

afterEach(() => {
  for (const { root, parent } of temporaryRoots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(parent)) {
      throw new Error('Unexpected pack-smoke fixture directory')
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const fixture = () => {
  const parent = tmpdir()
  const root = mkdtempSync(join(parent, 'hive-smoke-options 中文 '))
  temporaryRoots.push({ root, parent })
  const tarball = gzipSync('This archive must be rejected before installation.')
  const tarballPath = join(root, 'fixture-1.0.0.tgz')
  const manifestPath = join(root, 'release-manifest.json')
  const reportPath = join(root, 'reports', 'failure.json')
  const manifest = `${JSON.stringify({
    schema_version: 1,
    package_name: 'hive-smoke-options-fixture',
    version: '1.0.0',
    source_commit: 'a'.repeat(40),
    source_dirty: false,
    lockfile_sha256: createHash('sha256').update('fixture lockfile').digest('hex'),
    packaging: { node_version: process.version, platform: process.platform, arch: process.arch },
    tarball: {
      filename: 'fixture-1.0.0.tgz',
      size: tarball.length,
      // A correct size and deliberately wrong digest isolate SHA validation.
      sha256: createHash('sha256').update(tarball).update('changed').digest('hex'),
    },
  })}\n`
  writeFileSync(tarballPath, tarball)
  writeFileSync(manifestPath, manifest)
  return { root, tarballPath, tarball, manifestPath, manifest, reportPath }
}

const runCli = (input, args = []) => {
  const env = { ...process.env }
  const result = spawnSync(
    process.execPath,
    [cli, '--artifact', input.manifestPath, '--report', input.reportPath, ...args],
    {
      cwd: input.root,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 25_000,
    }
  )
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  expect(result.error, output).toBeUndefined()
  expect(result.status, output).toBe(1)
  expect(existsSync(input.reportPath), output).toBe(true)
  const receipt = JSON.parse(readFileSync(input.reportPath, 'utf8'))
  expect(receipt).toMatchObject({
    schema_version: 1,
    status: 'failed',
    environment: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  })
  return receipt
}

test.each([
  ['node', '0.0.0'],
  ['platform', process.platform === 'win32' ? 'linux' : 'win32'],
])(
  'the CLI records an expected-%s mismatch before artifact verification',
  (option, expected) => {
    const input = fixture()
    const receipt = runCli(input, [`--expected-${option}`, expected])
    expect(receipt.failure.stage).toBe('environment')
    expect(receipt.failure.message).toContain(`Unexpected ${option}`)
    expect(receipt.checks).not.toHaveProperty('artifact_digest')
    expect(receipt.checks).not.toHaveProperty('install')
    expect(readFileSync(input.manifestPath, 'utf8')).toBe(input.manifest)
    expect(readFileSync(input.tarballPath)).toEqual(input.tarball)
  },
  30_000
)

test('the CLI reports a rejected archive digest and preserves external artifact inputs', () => {
  const input = fixture()
  const receipt = runCli(input, [
    '--expected-node',
    process.version.slice(1),
    '--expected-platform',
    process.platform,
    '--expected-arch',
    process.arch,
  ])
  expect(receipt.failure).toMatchObject({
    stage: 'verify artifact',
    message: 'Release artifact tarball SHA-256 mismatch',
  })
  expect(receipt.checks.environment).toEqual({ status: 'passed' })
  expect(receipt.checks.cleanup).toEqual({ status: 'passed' })
  expect(receipt.checks).not.toHaveProperty('artifact_digest')
  expect(receipt.checks).not.toHaveProperty('install')
  expect(readFileSync(input.manifestPath, 'utf8')).toBe(input.manifest)
  expect(readFileSync(input.tarballPath)).toEqual(input.tarball)
}, 30_000)
