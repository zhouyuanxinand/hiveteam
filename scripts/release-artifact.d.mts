export interface ReleaseArtifactManifest {
  schema_version: 1
  package_name: string
  version: string
  source_commit: string
  source_dirty: boolean
  lockfile_sha256: string
  packaging: { node_version: string; platform: string; arch: string }
  tarball: { filename: string; sha256: string; size: number }
}

export function createReleaseArtifact(input: {
  repository: string
  outputDirectory: string
}): Promise<{ manifest: ReleaseArtifactManifest; manifestPath: string; tarballPath: string }>

export function verifyReleaseArtifact(
  manifestPath: string
): Promise<{ manifest: ReleaseArtifactManifest; tarballPath: string }>
