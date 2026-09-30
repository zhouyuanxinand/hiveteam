import agentNamesBank from './agent-names.json' with { type: 'json' }
import type { WorkerRole } from './types.js'

/**
 * The vendored 2.1.19 name snapshot is intentionally shared by the browser
 * and runtime for callers that explicitly need a random catalog name.
 * Default member names use their role or template through generateRoleWorkerName.
 */
export const WORKER_NAME_POOL: readonly string[] = agentNamesBank.names.map((entry) => entry.name)

const nextRandomUint32 = (): number => {
  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return values[0] ?? 0
}

export interface GenerateWorkerNameOptions {
  /** Names already in use in the current workspace. */
  usedNames?: ReadonlySet<string>
  /** Injectable in tests and scenario construction. */
  nextUint32?: () => number
}

export const generateWorkerName = ({
  usedNames,
  nextUint32 = nextRandomUint32,
}: GenerateWorkerNameOptions = {}): string => {
  const available =
    usedNames && usedNames.size > 0
      ? WORKER_NAME_POOL.filter((name) => !usedNames.has(name))
      : WORKER_NAME_POOL
  // A fully occupied 1,111-name pool is rare. Return a deterministic pool
  // member here; callers that require a guaranteed unique name append a
  // suffix, or use generateRoleWorkerName for a unique role-based suggestion.
  const draw = available.length > 0 ? available : WORKER_NAME_POOL
  return draw[nextUint32() % draw.length] ?? 'HiveTeam member'
}

const roleNames: Record<WorkerRole, string> = {
  coder: 'Coder',
  reviewer: 'Reviewer',
  tester: 'Tester',
  custom: 'Custom',
}

/** Role and template names remain stable across UI languages and list refreshes. */
export const generateRoleWorkerName = ({
  role,
  baseName,
  usedNames = new Set<string>(),
}: {
  role: WorkerRole
  baseName?: string | undefined
  usedNames?: ReadonlySet<string> | undefined
}): string => {
  const base = baseName?.trim() || roleNames[role]
  // The API limit counts UTF-16 code units; do not leave half an emoji at the boundary.
  const shortened = (length: number) =>
    base
      .slice(0, length)
      .replace(/[\uD800-\uDBFF]$/, '')
      .trimEnd()
  const candidate = shortened(64)
  if (!usedNames.has(candidate)) return candidate
  for (let index = 2; ; index += 1) {
    const suffix = ` ${index}`
    const name = `${shortened(64 - suffix.length)}${suffix}`
    if (!usedNames.has(name)) return name
  }
}
