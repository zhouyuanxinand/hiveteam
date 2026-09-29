import { parseArgs } from 'node:util'
import { createReleaseArtifact } from './release-artifact.mjs'

const main = async () => {
  const { values } = parseArgs({ options: { output: { type: 'string' } }, allowPositionals: false })
  if (!values.output)
    throw new Error('Usage: node scripts/create-release-artifact.mjs --output <directory>')
  const { manifestPath } = await createReleaseArtifact({
    repository: process.cwd(),
    outputDirectory: values.output,
  })
  process.stdout.write(`${manifestPath}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
