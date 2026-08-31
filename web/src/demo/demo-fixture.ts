import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'

export const DEMO_WORKSPACE: WorkspaceSummary = {
  id: 'demo-workspace',
  language: 'en',
  name: 'demo-todo-app',
  path: '/Users/you/demo-todo-app',
}

/**
 * The orchestrator is split out from `DEMO_WORKERS` to match production:
 * `listWorkers` excludes the orchestrator from the team list. Threading it
 * into the workers array would render queen as a worker card alongside alice
 * and bob, which is not how Hive actually behaves.
 */
export const DEMO_ORCHESTRATOR = {
  id: 'demo-orch',
  name: 'queen',
  status: 'idle' as const,
  pendingTaskCount: 0,
}

export const DEMO_WORKERS: TeamListItem[] = [
  {
    id: 'demo-coder',
    name: 'alice',
    role: 'coder',
    status: 'working',
    pendingTaskCount: 1,
    lastPtyLine: 'Editing src/routes/todos.ts (line 42)',
    commandPresetId: 'claude',
  },
  {
    id: 'demo-reviewer',
    name: 'bob',
    role: 'reviewer',
    status: 'idle',
    pendingTaskCount: 0,
    commandPresetId: 'gemini',
  },
]

const demoCoder = DEMO_WORKERS[0]
const demoReviewer = DEMO_WORKERS[1]

if (!demoCoder || !demoReviewer) {
  throw new Error('Demo replay requires a coder and a reviewer')
}

export const DEMO_TASKS_MD = `# Todo app

- [x] Set up Express server
- [x] Add /todos GET endpoint
- [ ] Add /todos POST endpoint
- [ ] Write Vitest for both endpoints
- [ ] Wire up SQLite for persistence
`

export const DEMO_TERMINAL_SCROLLBACK: Record<string, string> = {
  'demo-orch':
    '$ team send alice "Implement POST /todos"\r\n' +
    '> dispatched to alice\r\n' +
    '$ team list\r\n' +
    '> alice: working (1 task)\r\n' +
    '> bob: idle\r\n',
  'demo-coder':
    'Reading src/routes/todos.ts ...\r\n' +
    'Drafting POST handler ...\r\n' +
    'Editing src/routes/todos.ts (line 42)\r\n',
  'demo-reviewer': 'Idle — waiting for review tasks.\r\n',
}

export interface DemoReplaySnapshot {
  phase: number
  tasksMd: string
  terminalScrollback: Record<string, string>
  workers: TeamListItem[]
}

const replayWorker = (worker: TeamListItem, changes: Partial<TeamListItem>): TeamListItem => ({
  ...worker,
  ...changes,
})

export const DEMO_REPLAY_STEPS: Omit<DemoReplaySnapshot, 'phase'>[] = [
  {
    tasksMd: DEMO_TASKS_MD,
    terminalScrollback: DEMO_TERMINAL_SCROLLBACK,
    workers: DEMO_WORKERS,
  },
  {
    tasksMd: `# Todo app

- [x] Set up Express server
- [x] Add /todos GET endpoint
- [x] Add /todos POST endpoint
- [ ] Write Vitest for both endpoints
- [ ] Wire up SQLite for persistence
`,
    terminalScrollback: {
      'demo-orch':
        '$ team report "alice completed POST /todos"\r\n' +
        '> report received from alice\r\n' +
        '$ team send bob "Review the todo endpoint and tests"\r\n' +
        '> dispatched to bob\r\n',
      'demo-coder':
        'POST /todos handler added\r\n' +
        'Added validation and 201 response\r\n' +
        'Reporting completion to queen ...\r\n',
      'demo-reviewer':
        'Dispatch received from queen ...\r\n' + 'Reviewing endpoint contract ...\r\n',
    },
    workers: [
      replayWorker(demoCoder, {
        lastPtyLine: 'POST /todos handler added',
        pendingTaskCount: 0,
        status: 'idle',
      }),
      replayWorker(demoReviewer, {
        lastPtyLine: 'Reviewing endpoint contract ...',
        pendingTaskCount: 1,
        status: 'working',
      }),
    ],
  },
  {
    tasksMd: `# Todo app

- [x] Set up Express server
- [x] Add /todos GET endpoint
- [x] Add /todos POST endpoint
- [x] Write Vitest for both endpoints
- [x] Wire up SQLite for persistence
`,
    terminalScrollback: {
      'demo-orch':
        '$ team report "bob verified the endpoint and tests"\r\n' +
        '> report received from bob\r\n' +
        '$ team list\r\n' +
        '> alice: idle (0 tasks)\r\n' +
        '> bob: idle (0 tasks)\r\n',
      'demo-coder': 'Idle — ready for the next task.\r\n',
      'demo-reviewer':
        'Review complete: endpoint and tests look good\r\n' +
        'Reporting completion to queen ...\r\n',
    },
    workers: [
      replayWorker(demoCoder, {
        lastPtyLine: 'Idle — ready for the next task.',
        pendingTaskCount: 0,
        status: 'idle',
      }),
      replayWorker(demoReviewer, {
        lastPtyLine: 'Review complete: endpoint and tests look good',
        pendingTaskCount: 0,
        status: 'idle',
      }),
    ],
  },
]
