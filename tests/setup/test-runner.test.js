import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const temporaryRoots = []

afterEach(() => {
  for (const { root, parent } of temporaryRoots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(parent)) throw new Error('Unexpected fixture directory')
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const fixture = () => {
  const parent = tmpdir()
  const root = mkdtempSync(join(parent, 'hive-runner-fixture-'))
  temporaryRoots.push({ root, parent })
  const inherited = join(root, 'inherited-data')
  mkdirSync(inherited)
  writeFileSync(join(inherited, 'keep.txt'), 'user data')
  const config = join(root, 'vitest.config.mjs')
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      root,
      test: { include: ['probe.test.mjs'], fileParallelism: false, maxWorkers: 1 },
    })}\n`
  )
  writeFileSync(
    join(root, 'probe.test.mjs'),
    `import { test, expect } from ${JSON.stringify(join(repository, 'node_modules/vitest/dist/index.js').replaceAll('\\', '/'))}
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('probe', () => {
  const dataDir = process.env.HIVE_DATA_DIR
  expect(dataDir).toBeTruthy()
  expect(dataDir).not.toBe(process.env.TEST_PARENT_DATA_DIR)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'child-write.txt'), 'isolated')
  writeFileSync(process.env.TEST_OBSERVATION, JSON.stringify({ dataDir, temporary: tmpdir() }))
  expect(process.env.TEST_SHOULD_FAIL).not.toBe('yes')
})
`
  )
  return { config, inherited, root }
}

const run = (input, observation, fail = false, options = {}) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(
          repository,
          options.direct ? 'node_modules/vitest/vitest.mjs' : 'scripts/run-tests.mjs'
        ),
        'run',
        '--config',
        input.config,
      ],
      {
        cwd: repository,
        env: {
          ...(options.env ?? process.env),
          HIVE_DATA_DIR: input.inherited,
          TEST_PARENT_DATA_DIR: input.inherited,
          TEST_OBSERVATION: observation,
          TEST_SHOULD_FAIL: fail ? 'yes' : 'no',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => resolveResult({ code, output }))
  })

test('test runs isolate inherited data and remove only their own files after child exit', async () => {
  const input = fixture()
  const dataDirectories = []
  for (const iteration of [1, 2]) {
    const observation = join(input.root, `observation-${iteration}.json`)
    const result = await run(input, observation)
    expect(result.code, result.output).toBe(0)
    const observed = JSON.parse(readFileSync(observation, 'utf8'))
    dataDirectories.push(observed.dataDir)
    expect(observed.temporary.startsWith(`${dirname(observed.dataDir)}${sep}`)).toBe(true)
    expect(existsSync(dirname(observed.dataDir))).toBe(false)
  }
  expect(new Set(dataDirectories).size).toBe(2)
  expect(readFileSync(join(input.inherited, 'keep.txt'), 'utf8')).toBe('user data')
  expect(existsSync(join(input.inherited, 'child-write.txt'))).toBe(false)
}, 30_000)

test('a failing Vitest child preserves its exit code and still removes its isolated data', async () => {
  const input = fixture()
  const observation = join(input.root, 'failed-observation.json')
  const result = await run(input, observation, true)
  expect(result.code, result.output).toBe(1)
  const observed = JSON.parse(readFileSync(observation, 'utf8'))
  expect(existsSync(dirname(observed.dataDir))).toBe(false)
  expect(readFileSync(join(input.inherited, 'keep.txt'), 'utf8')).toBe('user data')
}, 30_000)

test.each([
  'runner',
  'direct setup',
])('%s prevents temporary workspaces from using an ancestor Git repository', async (mode) => {
  const input = fixture()
  const childTemporary = join(input.root, 'child-temporary')
  mkdirSync(childTemporary)
  const gitEnvironment = { ...process.env }
  // Git's explicit repository overrides must not redirect this owned fixture.
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'])
    delete gitEnvironment[name]
  const initialized = spawnSync('git', ['init', '--quiet', input.root], {
    env: gitEnvironment,
    encoding: 'utf8',
    windowsHide: true,
  })
  expect(initialized.status, initialized.stderr).toBe(0)
  const direct = mode === 'direct setup'
  writeFileSync(
    input.config,
    `export default ${JSON.stringify({
      root: input.root,
      test: {
        include: ['probe.test.mjs'],
        fileParallelism: false,
        maxWorkers: 1,
        ...(direct
          ? { setupFiles: [join(repository, 'tests/setup/vitest.setup.ts').replaceAll('\\', '/')] }
          : {}),
      },
    })}\n`
  )
  writeFileSync(
    join(input.root, 'probe.test.mjs'),
    `
import { test, expect } from ${JSON.stringify(join(repository, 'node_modules/vitest/dist/index.js').replaceAll('\\', '/'))}
import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('real Git discovery stays inside the test boundary', () => {
  const workspace = join(tmpdir(), 'default-workspace')
  mkdirSync(workspace)
  const git = (args, env = process.env) => spawnSync('git', ['-C', workspace, ...args], {
    env, encoding: 'utf8', windowsHide: true,
  })
  // This is our own parent repository: the control proves discovery would
  // succeed without the production test environment's ceiling.
  const unbounded = git(['rev-parse', '--show-toplevel'], { ...process.env, GIT_CEILING_DIRECTORIES: '' })
  expect(unbounded.status, unbounded.stderr).toBe(0)
  expect(realpathSync(unbounded.stdout.trim())).toBe(realpathSync(${JSON.stringify(input.root)}))
  const isolated = git(['rev-parse', '--show-toplevel'])
  expect(isolated.status).not.toBe(0)
  expect(isolated.stdout).toBe('')
  const localInit = git(['init', '--quiet'])
  expect(localInit.status, localInit.stderr).toBe(0)
  const local = git(['rev-parse', '--show-toplevel'])
  expect(local.status, local.stderr).toBe(0)
  expect(realpathSync(local.stdout.trim())).toBe(realpathSync(workspace))
  writeFileSync(process.env.TEST_OBSERVATION, JSON.stringify({ bounded: isolated.status, local: local.status }))
})
`
  )
  const observation = join(input.root, 'git-observation.json')
  const result = await run(input, observation, false, {
    direct,
    env: {
      ...gitEnvironment,
      GIT_CEILING_DIRECTORIES: '',
      HIVE_TEST_RUN_ROOT: '',
      TEMP: childTemporary,
      TMP: childTemporary,
      TMPDIR: childTemporary,
    },
  })
  expect(result.code, result.output).toBe(0)
  const observed = JSON.parse(readFileSync(observation, 'utf8'))
  expect(observed.bounded).not.toBe(0)
  expect(observed.local).toBe(0)
  expect(readFileSync(join(input.inherited, 'keep.txt'), 'utf8')).toBe('user data')
}, 30_000)
