import type { TeamOperationsInput } from '../../src/server/team-operations.js'
import type { TeamSkillRuntime } from '../../src/server/team-skill-runtime.js'

export const readyTeamSkillRuntime: Pick<TeamSkillRuntime, 'assertLaunchReady'> = {
  assertLaunchReady: async () => ({
    catalog: [],
    nativeDiscovery: 'prompt_only',
    nativeError: null,
  }),
}

export const rejectUnexpectedTeamSkillOperations: Pick<
  TeamOperationsInput,
  | 'createDispatchActivation'
  | 'getDispatchActivation'
  | 'resolveDispatchActivation'
  | 'clarificationForWorker'
> = {
  clarificationForWorker: () => null,
  createDispatchActivation: () => {
    throw new Error('Unexpected Skill activation in a non-Skill test')
  },
  getDispatchActivation: () => null,
  resolveDispatchActivation: async () => {
    throw new Error('Unexpected Skill resolution in a non-Skill test')
  },
}
