import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import { npmCommand } from './npm-command.mjs'
import { preparePackagePermissions } from './package-permissions.mjs'

const runFile = promisify(execFile)
const manifestFilename = 'release-manifest.json'
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value.trim().length > 0
const isSha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

const isTarballFilename = (filename) =>
  typeof filename === 'string' &&
  filename.length > 4 &&
  filename.endsWith('.tgz') &&
  !filename.includes(':') &&
  !filename.includes('\0') &&
  posix.basename(filename) === filename &&
  win32.basename(filename) === filename

const validateManifest = (manifest) => {
  if (
    !isRecord(manifest) ||
    manifest.schema_version !== 1 ||
    !isText(manifest.package_name) ||
    !isText(manifest.version) ||
    typeof manifest.source_commit !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.source_commit) ||
    typeof manifest.source_dirty !== 'boolean' ||
    !isSha256(manifest.lockfile_sha256) ||
    !isRecord(manifest.packaging) ||
    !isText(manifest.packaging.node_version) ||
    !isText(manifest.packaging.platform) ||
    !isText(manifest.packaging.arch) ||
    !isRecord(manifest.tarball) ||
    !isTarballFilename(manifest.tarball.filename) ||
    !isSha256(manifest.tarball.sha256) ||
    !Number.isSafeInteger(manifest.tarball.size) ||
    manifest.tarball.size <= 0
  ) {
    throw new Error('Invalid release artifact manifest')
  }
}

const fingerprintTarball = async (tarballPath) => {
  const stat = await lstat(tarballPath)
  if (!stat.isFile()) throw new Error('Release artifact tarball must be a regular file')
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(tarballPath)) {
    size += chunk.length
    hash.update(chunk)
  }
  return { sha256: hash.digest('hex'), size }
}

export const verifyReleaseArtifact = async (manifestPath) => {
  const absoluteManifestPath = resolve(manifestPath)
  const manifest = JSON.parse(await readFile(absoluteManifestPath, 'utf8'))
  validateManifest(manifest)
  const tarballPath = join(dirname(absoluteManifestPath), manifest.tarball.filename)
  const actual = await fingerprintTarball(tarballPath)
  if (actual.size !== manifest.tarball.size)
    throw new Error('Release artifact tarball size mismatch')
  if (actual.sha256 !== manifest.tarball.sha256)
    throw new Error('Release artifact tarball SHA-256 mismatch')
  return { manifest, tarballPath }
}

export const createReleaseArtifact = async ({ repository, outputDirectory }) => {
  const root = resolve(repository)
  const destination = resolve(outputDirectory)
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (!isText(packageJson.name) || !isText(packageJson.version)) {
    throw new Error('Release package must have a name and version')
  }
  // Capture provenance before creating output files; a dirty tree remains explicitly dirty.
  const [commit, status, lockfile] = await Promise.all([
    runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }),
    runFile('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }),
    readFile(join(root, 'pnpm-lock.yaml')),
  ])
  await mkdir(destination, { recursive: true })
  const npm = npmCommand(
    ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }
  )
  const packed = JSON.parse((await runFile(npm.file, npm.args, npm.options)).stdout)
  const results = Array.isArray(packed) ? packed : isRecord(packed) ? Object.values(packed) : []
  const [result] = results
  if (
    results.length !== 1 ||
    !isRecord(result) ||
    result.name !== packageJson.name ||
    result.version !== packageJson.version ||
    !isTarballFilename(result.filename)
  ) {
    throw new Error('npm pack returned invalid release package metadata')
  }
  const tarballPath = join(destination, result.filename)
  await preparePackagePermissions(tarballPath)
  const fingerprint = await fingerprintTarball(tarballPath)
  const manifest = {
    schema_version: 1,
    package_name: packageJson.name,
    version: packageJson.version,
    source_commit: commit.stdout.trim(),
    source_dirty: status.stdout.length > 0,
    lockfile_sha256: createHash('sha256').update(lockfile).digest('hex'),
    packaging: { node_version: process.version, platform: process.platform, arch: process.arch },
    tarball: { filename: result.filename, ...fingerprint },
  }
  validateManifest(manifest)
  const manifestPath = join(destination, manifestFilename)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { manifest, manifestPath, tarballPath }
}
