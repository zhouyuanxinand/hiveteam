import { generateRoleWorkerName } from '../shared/random-worker-name.js'
import type { TeamScenarioMember } from '../shared/team-scenarios.js'

/** Keep each scenario's specialized role name, adding a stable suffix when occupied. */
export const buildScenarioWorkerName = (
  member: TeamScenarioMember,
  usedNames: ReadonlySet<string>
) => generateRoleWorkerName({ role: member.role, baseName: member.name, usedNames })
