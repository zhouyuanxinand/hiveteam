import type { WorkerRole } from './types.js'

export interface TeamScenarioMember {
  description: string
  id: string
  name: string
  role: Exclude<WorkerRole, 'custom'>
}

export interface TeamScenarioDefinition {
  description: string
  id: string
  members: TeamScenarioMember[]
  name: string
}

/** Small, opinionated teams for the common “start working now” cases. */
export const TEAM_SCENARIOS: TeamScenarioDefinition[] = [
  {
    description: 'Implement, review, and verify a change as one coordinated team.',
    id: 'ship-feature',
    members: [
      {
        description: 'Owns the implementation and reports the changed files and checks.',
        id: 'builder',
        name: 'Builder',
        role: 'coder',
      },
      {
        description: 'Reviews the implementation for correctness, regressions, and security.',
        id: 'reviewer',
        name: 'Reviewer',
        role: 'reviewer',
      },
      {
        description: 'Runs focused validation and reports reproducible failures.',
        id: 'tester',
        name: 'Tester',
        role: 'tester',
      },
    ],
    name: 'Ship a feature',
  },
  {
    description: 'Use a compact pair for a bug fix with an independent review.',
    id: 'fix-a-bug',
    members: [
      {
        description: 'Reproduces the issue, implements the smallest safe fix, and validates it.',
        id: 'fixer',
        name: 'Fixer',
        role: 'coder',
      },
      {
        description: 'Checks the fix, edge cases, and whether the regression is covered.',
        id: 'reviewer',
        name: 'Reviewer',
        role: 'reviewer',
      },
    ],
    name: 'Fix a bug',
  },
  {
    description: 'Research an unfamiliar codebase and turn findings into an actionable note.',
    id: 'understand-a-repo',
    members: [
      {
        description: 'Maps the repository entry points, dependencies, and execution flow.',
        id: 'explorer',
        name: 'Explorer',
        role: 'coder',
      },
      {
        description: 'Challenges assumptions and checks the findings against the source.',
        id: 'reviewer',
        name: 'Reviewer',
        role: 'reviewer',
      },
    ],
    name: 'Understand a repository',
  },
]

export const getTeamScenario = (id: string) => TEAM_SCENARIOS.find((scenario) => scenario.id === id)
