import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { createReleaseArtifact } from '../../scripts/release-artifact.mjs'

const runFile = promisify(execFile)
const publisher = fileURLToPath(
  new URL('../../scripts/publish-release-artifact.mjs', import.meta.url)
)
const roots = []
const servers = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose()))
    )
  }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()))
      throw new Error('Unexpected npm release fixture directory')
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const fixture = async (version = '1.2.3') => {
  const publications = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'PUT') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not_found' }))
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    publications.push(JSON.parse(Buffer.concat(chunks).toString()))
    response.writeHead(201, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  servers.push(server)
  const registry = `http://127.0.0.1:${server.address().port}/`
  const root = mkdtempSync(join(tmpdir(), 'hive-npm-release-'))
  roots.push(root)
  const source = join(root, 'source')
  mkdirSync(source)
  const packageName = 'hive-npm-release-fixture'
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: packageName,
      version,
      files: ['index.js'],
      publishConfig: { registry },
      scripts: {
        prepack: 'node -e "throw new Error(\'Must publish the existing archive\')"',
      },
    })
  )
  writeFileSync(join(source, 'index.js'), 'export const answer = 42\n')
  writeFileSync(join(source, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  const hooks = join(root, 'empty-hooks')
  mkdirSync(hooks)
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
        'user.name=Release Test',
        '-c',
        'user.email=release-test@example.invalid',
        ...args,
      ],
      { cwd: source, windowsHide: true }
    )
  git(['init', '--quiet'])
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'Create release fixture'])
  const artifact = await createReleaseArtifact({
    repository: source,
    outputDirectory: join(root, 'release output'),
  })
  const userconfig = join(root, 'npmrc')
  writeFileSync(
    userconfig,
    `registry=${registry}\n//127.0.0.1:${server.address().port}/:_authToken=fixture-token\n`
  )
  const publish = (args = []) =>
    runFile(process.execPath, [publisher, '--artifact', artifact.manifestPath, ...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        npm_config_registry: registry,
        npm_config_userconfig: userconfig,
        npm_config_cache: join(root, 'npm-cache'),
      },
    })
  return { artifact, packageName, publications, publish }
}

test.each([
  { version: '1.2.3', tag: 'latest' },
  { version: '1.2.4-beta.1', tag: 'next' },
])('publishes the exact verified archive with dist-tag $tag', async ({ version, tag }) => {
  const { artifact, packageName, publications, publish } = await fixture(version)
  const original = readFileSync(artifact.tarballPath)
  await publish(['--release-tag', `v${version}`])
  expect(publications).toHaveLength(1)
  const [publication] = publications
  expect(publication.name).toBe(packageName)
  expect(publication['dist-tags']).toEqual({ [tag]: version })
  expect(publication.versions[version].name).toBe(packageName)
  const attachments = Object.values(publication._attachments)
  expect(attachments).toHaveLength(1)
  expect(Buffer.from(attachments[0].data, 'base64')).toEqual(original)
  expect(readFileSync(artifact.tarballPath)).toEqual(original)
})

test('a mismatched release tag exits with an error before publishing', async () => {
  const { publications, publish } = await fixture()
  await expect(publish(['--release-tag', 'v9.9.9'])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Release tag must be v1.2.3, got v9.9.9'),
  })
  expect(publications).toEqual([])
})

test('a modified archive exits with an error before publishing', async () => {
  const { artifact, publications, publish } = await fixture()
  const modified = readFileSync(artifact.tarballPath)
  modified[modified.length - 1] ^= 1
  writeFileSync(artifact.tarballPath, modified)
  await expect(publish()).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Release artifact tarball SHA-256 mismatch'),
  })
  expect(publications).toEqual([])
})

test('dry-run exercises npm publishing without uploading the archive', async () => {
  const { publications, publish } = await fixture()
  const { stdout } = await publish(['--dry-run'])
  expect(stdout).toContain('Publishing hive-npm-release-fixture@1.2.3 with dist-tag latest')
  expect(stdout).toContain('+ hive-npm-release-fixture@1.2.3')
  expect(publications).toEqual([])
})
