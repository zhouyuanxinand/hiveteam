interface Semver {
  core: [string, string, string]
  prerelease: string[]
}

const versionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const numericPattern = /^[0-9]+$/

const parseSemver = (version: string): Semver | null => {
  const match = versionPattern.exec(version)
  if (!match || match[0] !== version) return null
  const [, major, minor, patch] = match
  if (major === undefined || minor === undefined || patch === undefined) return null
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((part) => numericPattern.test(part) && part.length > 1 && part[0] === '0')) {
    return null
  }
  return { core: [major, minor, patch], prerelease }
}

const compareText = (left: string, right: string): -1 | 0 | 1 =>
  left === right ? 0 : left < right ? -1 : 1

const compareNumeric = (left: string, right: string): -1 | 0 | 1 =>
  left.length === right.length ? compareText(left, right) : left.length < right.length ? -1 : 1

/** SemVer 2.0 precedence; build metadata is ignored and invalid versions return null. */
export const compareSemverVersions = (
  leftVersion: string,
  rightVersion: string
): -1 | 0 | 1 | null => {
  const left = parseSemver(leftVersion)
  const right = parseSemver(rightVersion)
  if (!left || !right) return null
  for (const index of [0, 1, 2] as const) {
    const comparison = compareNumeric(left.core[index], right.core[index])
    if (comparison !== 0) return comparison
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1
  }
  for (const [index, leftPart] of left.prerelease.entries()) {
    const rightPart = right.prerelease[index]
    if (rightPart === undefined) return 1
    const leftNumeric = numericPattern.test(leftPart)
    const rightNumeric = numericPattern.test(rightPart)
    const comparison =
      leftNumeric && rightNumeric
        ? compareNumeric(leftPart, rightPart)
        : leftNumeric !== rightNumeric
          ? leftNumeric
            ? -1
            : 1
          : compareText(leftPart, rightPart)
    if (comparison !== 0) return comparison
  }
  return left.prerelease.length === right.prerelease.length ? 0 : -1
}
