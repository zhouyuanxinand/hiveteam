import { randomBytes } from 'node:crypto'

import { generateWorkerName } from '../shared/random-worker-name.js'
import type { TeamScenarioMember } from '../shared/team-scenarios.js'

/**
 * Scenario members draw from the same name catalog as manually added members.
 * The normal generator excludes existing names; the suffix fallback only runs
 * after every catalog entry is occupied, so launching a scenario never fails
 * just because a busy workspace exhausted the static bank.
 */
export const buildScenarioWorkerName = (
  member: TeamScenarioMember,
  usedNames: ReadonlySet<string>,
  input: { nextUint32?: () => number } = {},
  maxAttempts = 16
) => {
  const candidate = generateWorkerName({
    usedNames,
    ...(input.nextUint32 ? { nextUint32: input.nextUint32 } : {}),
  })
  if (!usedNames.has(candidate)) return candidate

  const base = candidate || member.name
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const suffix = randomBytes(3).toString('hex')
    const generated = `${base}-${suffix}`
    if (!usedNames.has(generated)) return generated
  }
  throw new Error(`Could not generate a unique member name for: ${member.id}`)
}
