import agentNamesBank from './agent-names.json' with { type: 'json' }

/**
 * The vendored 2.1.19 name snapshot is intentionally shared by the browser
 * and runtime. This keeps manual Add Member and scenario teams in one
 * namespace, regardless of role or display language.
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
  // short suffix (see scenario-worker-name.ts).
  const draw = available.length > 0 ? available : WORKER_NAME_POOL
  return draw[nextUint32() % draw.length] ?? 'Hive member'
}
