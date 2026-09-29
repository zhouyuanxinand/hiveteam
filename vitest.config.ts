import { defineConfig } from 'vitest/config'

const runtimeSuites = [
  'tests/{cli,gateway,integration,manual,server}/**/*.test.{js,ts,tsx}',
  'tests/unit/git-diff-reader.test.ts',
]
const uiFlows = ['tests/web/{worker-flow,workspace-flow}.test.tsx']

export default defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'logic-and-ui',
          include: ['tests/**/*.test.{js,ts,tsx}'],
          exclude: [...runtimeSuites, ...uiFlows],
          testTimeout: 5_000,
          hookTimeout: 10_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'ui-flows',
          include: uiFlows,
          // Full workspace/member flows exceed 5s on Windows; small UI tests
          // retain the normal limit in logic-and-ui.
          testTimeout: 15_000,
          hookTimeout: 10_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'runtime',
          include: runtimeSuites,
          // These suites cross HTTP, SQLite, Git, CLI or real PTY boundaries.
          // Startup/restart scenarios already wait up to 8–15 seconds internally;
          // allow startup and teardown without raising ordinary assertion limits.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
})
