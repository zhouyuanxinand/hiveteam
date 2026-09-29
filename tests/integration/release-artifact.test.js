import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { list } from 'tar'
import { afterEach, expect, test } from 'vitest'
import { createReleaseArtifact, verifyReleaseArtifact } from '../../scripts/release-artifact.mjs'

const temporaryRoots = []
const creatorCli = fileURLToPath(
  new URL('../../scripts/create-release-artifact.mjs', import.meta.url)
)
const sha256 = (content) => createHash('sha256').update(content).digest('hex')

afterEach(() => {
  for (const { root, parent } of temporaryRoots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(parent))
      throw new Error('Unexpected artifact fixture directory')
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const fixture = () => {
  const parent = tmpdir()
  const root = mkdtempSync(join(parent, 'hive-artifact-fixture-'))
  temporaryRoots.push({ root, parent })
  const repository = join(root, 'source')
  const outputDirectory = join(root, 'release output')
  const hooks = join(root, 'empty-hooks')
  mkdirSync(repository)
  mkdirSync(hooks)
  writeFileSync(
    join(repository, 'package.json'),
    `${JSON.stringify(
      {
        name: '@hive-artifact-test/fixture',
        version: '1.2.3',
        files: ['index.js', 'payload.bin', 'dist/bin/team'],
        scripts: { prepack: 'node -e "throw new Error(\'Packing must not run another build\')"' },
      },
      null,
      2
    )}\n`
  )
  writeFileSync(join(repository, 'index.js'), 'export const answer = 42\n')
  const payload = randomBytes(256 * 1024)
  writeFileSync(join(repository, 'payload.bin'), payload)
  mkdirSync(join(repository, 'dist/bin'), { recursive: true })
  writeFileSync(join(repository, 'dist/bin/team'), '#!/bin/sh\nprintf "team launcher ready\\n"\n', {
    mode: 0o644,
  })
  const lockfile = "lockfileVersion: '9.0'\n"
  writeFileSync(join(repository, 'pnpm-lock.yaml'), lockfile)
  const git = (args) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.autocrlf=false',
        '-c',
        `core.hooksPath=${hooks}`,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Artifact Test',
        '-c',
        'user.email=artifact-test@example.invalid',
        ...args,
      ],
      { cwd: repository, encoding: 'utf8', windowsHide: true }
    )
  git(['init', '--quiet'])
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'Create fixture'])
  return {
    repository,
    outputDirectory,
    sourceCommit: git(['rev-parse', 'HEAD']).trim(),
    lockfile,
    payload,
  }
}

test('creates a real package with verifiable provenance and packaging metadata', async () => {
  const input = fixture()
  const artifact = await createReleaseArtifact(input)
  const tarball = readFileSync(artifact.tarballPath)
  expect(artifact.manifest).toEqual({
    schema_version: 1,
    package_name: '@hive-artifact-test/fixture',
    version: '1.2.3',
    source_commit: input.sourceCommit,
    source_dirty: false,
    lockfile_sha256: sha256(input.lockfile),
    packaging: { node_version: process.version, platform: process.platform, arch: process.arch },
    tarball: {
      filename: 'hive-artifact-test-fixture-1.2.3.tgz',
      sha256: sha256(tarball),
      size: tarball.length,
    },
  })
  expect([...tarball.subarray(0, 2)]).toEqual([0x1f, 0x8b])
  expect(readFileSync(artifact.manifestPath, 'utf8').endsWith('\n')).toBe(true)
  await expect(verifyReleaseArtifact(artifact.manifestPath)).resolves.toEqual({
    manifest: artifact.manifest,
    tarballPath: artifact.tarballPath,
  })
  const entries = []
  await list({
    file: artifact.tarballPath,
    onReadEntry(entry) {
      entries.push({ path: entry.path, mode: entry.mode })
    },
  })
  expect(entries).toContainEqual({ path: 'package/dist/bin/team', mode: 0o755 })
  expect(entries).toContainEqual({ path: 'package/index.js', mode: 0o644 })
  const extracted = join(input.outputDirectory, 'extracted')
  mkdirSync(extracted)
  execFileSync('tar', ['-xzf', artifact.tarballPath, '-C', extracted])
  expect(readFileSync(join(extracted, 'package/index.js'), 'utf8')).toBe(
    'export const answer = 42\n'
  )
  const launcher = join(extracted, 'package/dist/bin/team')
  expect(readFileSync(join(extracted, 'package/payload.bin'))).toEqual(input.payload)
  expect(readFileSync(launcher, 'utf8')).toBe('#!/bin/sh\nprintf "team launcher ready\\n"\n')
  if (process.platform !== 'win32') {
    expect(execFileSync(launcher, [], { encoding: 'utf8' })).toBe('team launcher ready\n')
  }
})

test('the creation CLI records dirty sources without claiming a new source commit', async () => {
  const input = fixture()
  writeFileSync(join(input.repository, 'index.js'), 'export const answer = 43\n')
  const manifestPath = execFileSync(
    process.execPath,
    [creatorCli, '--output', input.outputDirectory],
    {
      cwd: input.repository,
      encoding: 'utf8',
      windowsHide: true,
    }
  ).trim()
  const artifact = await verifyReleaseArtifact(manifestPath)
  expect(manifestPath).toBe(join(input.outputDirectory, 'release-manifest.json'))
  expect(artifact.manifest.source_commit).toBe(input.sourceCommit)
  expect(artifact.manifest.source_dirty).toBe(true)
  expect(artifact.manifest.packaging.node_version).toBe(process.version)
})

test('rejects changed tarball contents, changed length and an incorrect recorded digest', async () => {
  const artifact = await createReleaseArtifact(fixture())
  const original = readFileSync(artifact.tarballPath)
  const modified = Buffer.from(original)
  modified[modified.length - 1] ^= 1
  writeFileSync(artifact.tarballPath, modified)
  await expect(verifyReleaseArtifact(artifact.manifestPath)).rejects.toThrow('SHA-256 mismatch')
  writeFileSync(artifact.tarballPath, Buffer.concat([original, Buffer.from('changed')]))
  await expect(verifyReleaseArtifact(artifact.manifestPath)).rejects.toThrow('size mismatch')
  writeFileSync(artifact.tarballPath, original)
  const wrongDigest = structuredClone(artifact.manifest)
  wrongDigest.tarball.sha256 = '0'.repeat(64)
  writeFileSync(artifact.manifestPath, JSON.stringify(wrongDigest))
  await expect(verifyReleaseArtifact(artifact.manifestPath)).rejects.toThrow('SHA-256 mismatch')
})

test('rejects invalid manifest structure and filenames outside the manifest directory', async () => {
  const artifact = await createReleaseArtifact(fixture())
  const invalidManifests = [
    null,
    [],
    { ...artifact.manifest, schema_version: 2 },
    { ...artifact.manifest, source_commit: 'HEAD' },
    { ...artifact.manifest, source_dirty: 'false' },
    { ...artifact.manifest, lockfile_sha256: 'invalid' },
    { ...artifact.manifest, packaging: {} },
    ...[
      '../outside.tgz',
      '..\\outside.tgz',
      '/outside.tgz',
      'C:\\outside.tgz',
      'nested/package.tgz',
      'package.zip',
    ].map((filename) => ({
      ...artifact.manifest,
      tarball: { ...artifact.manifest.tarball, filename },
    })),
    ...[0, -1, 1.5, '100'].map((size) => ({
      ...artifact.manifest,
      tarball: { ...artifact.manifest.tarball, size },
    })),
  ]
  for (const manifest of invalidManifests) {
    writeFileSync(artifact.manifestPath, JSON.stringify(manifest))
    await expect(verifyReleaseArtifact(artifact.manifestPath)).rejects.toThrow(
      'Invalid release artifact manifest'
    )
  }
})
