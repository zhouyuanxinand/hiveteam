import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { npmCommand } from './npm-command.mjs'
import { verifyReleaseArtifact } from './release-artifact.mjs'

const main = async () => {
  const { values } = parseArgs({
    options: {
      artifact: { type: 'string' },
      'release-tag': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  if (!values.artifact)
    throw new Error(
      'Usage: node scripts/publish-release-artifact.mjs --artifact <manifest> [--release-tag v<version>] [--dry-run]'
    )

  const { manifest, tarballPath } = await verifyReleaseArtifact(values.artifact)
  if (values['release-tag'] && values['release-tag'] !== `v${manifest.version}`)
    throw new Error(`Release tag must be v${manifest.version}, got ${values['release-tag']}`)

  const tag = manifest.version.split('+')[0].includes('-') ? 'next' : 'latest'
  console.log(`Publishing ${manifest.package_name}@${manifest.version} with dist-tag ${tag}`)
  console.log(`Artifact SHA-256: ${manifest.tarball.sha256}`)
  const npm = npmCommand(
    [
      'publish',
      tarballPath,
      '--access',
      'public',
      '--tag',
      tag,
      '--ignore-scripts',
      ...(values['dry-run'] ? ['--dry-run'] : []),
    ],
    { stdio: 'inherit', timeout: 180_000 }
  )
  execFileSync(npm.file, npm.args, npm.options)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
