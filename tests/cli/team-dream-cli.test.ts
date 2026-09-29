import { spawn } from 'node:child_process'
import { afterEach, expect, test } from 'vitest'
import { parseDreamArgs } from '../../src/cli/team-dream.js'
import {
  startAuthorizedTestServer as startTestServer,
  type TestServerContext,
} from '../helpers/test-server.js'

let server: TestServerContext | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

const cli = (args: string[], env: Record<string, string>, input = '') =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/team.ts', 'dream', ...args],
      {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'EOF') reject(error)
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })

test('parses bounded Dream input and rejects result commands missing their frozen input identity', () => {
  expect(
    parseDreamArgs([
      'input',
      '--dream',
      'draft',
      '--section',
      'sources',
      '--offset',
      '10',
      '--limit',
      '2',
    ])
  ).toEqual({
    action: 'input',
    body: { dream_id: 'draft', section: 'sources', offset: 10, limit: 2 },
    useStdin: false,
  })
  expect(() => parseDreamArgs(['input', '--dream', 'draft', '--limit', '11'])).toThrow(
    'team dream input'
  )
  expect(() =>
    parseDreamArgs(['result', '--dream', 'draft', '--attempt', 'attempt', '--stdin'])
  ).toThrow('team dream result')
})

test('real CLI reads frozen pages and returns candidates through authenticated HTTP without applying memory', async () => {
  server = await startTestServer()
  const store = server.store
  const workspace = store.createWorkspace(server.dataDir, 'Dream CLI')
  const orchestratorId = `${workspace.id}:orchestrator`
  const port = new URL(server.baseUrl).port
  store.configureAgentLaunch(workspace.id, orchestratorId, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  await store.startAgent(workspace.id, orchestratorId, { hivePort: port })
  store.recordUserInput(
    workspace.id,
    orchestratorId,
    'The production API listens on port 4310. Keep this deployment decision.'
  )
  const draft = await store.requestMemoryDreamGeneration(workspace.id)
  if (!draft?.generation?.attempt_id) throw new Error('Expected a requested generation')
  const env = {
    HIVE_PROJECT_ID: workspace.id,
    HIVE_AGENT_ID: orchestratorId,
    HIVE_AGENT_TOKEN: store.peekAgentToken(orchestratorId) ?? '',
    HIVE_PORT: port,
  }
  const input = await cli(['input', '--dream', draft.id, '--limit', '1'], env)
  expect(input.code, input.stderr).toBe(0)
  const page = JSON.parse(input.stdout)
  expect(page.items[0]).toMatchObject({
    source_type: 'protocol_message',
    text: expect.stringContaining('4310'),
  })
  expect(page.input_hash).toBe(draft.generation.input_hash)
  const result = {
    candidates: [
      {
        body: 'The production API uses port 4310.',
        kind: 'decision',
        scope: 'workspace',
        procedure_ref: null,
        tags: ['deployment'],
        source_sequences: [page.items[0].sequence],
      },
    ],
    summary: 'One deployment decision.',
  }
  const args = [
    'result',
    '--dream',
    draft.id,
    '--attempt',
    draft.generation.attempt_id,
    '--input-hash',
    draft.generation.input_hash,
    '--stdin',
  ]
  const submitted = await cli(args, env, JSON.stringify(result))
  expect(submitted.code, submitted.stderr).toBe(0)
  expect(JSON.parse(submitted.stdout)).toMatchObject({
    status: 'review',
    generation_status: 'completed',
    candidate_count: 1,
  })
  expect(store.memory.list(workspace.id)).toEqual([])
  expect(store.memoryDream.get(workspace.id, draft.id)?.operations).toEqual([
    expect.objectContaining({
      action: 'add',
      result: expect.objectContaining({ body: 'The production API uses port 4310.' }),
    }),
  ])
  const repeated = await cli(args, env, JSON.stringify(result))
  expect(repeated.code, repeated.stderr).toBe(0)
  expect(JSON.parse(repeated.stdout)).toEqual(JSON.parse(submitted.stdout))
  const worker = store.addWorker(workspace.id, { name: 'Reader', role: 'coder' })
  store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  await store.startAgent(workspace.id, worker.id, { hivePort: port })
  const workerEnv = {
    ...env,
    HIVE_AGENT_ID: worker.id,
    HIVE_AGENT_TOKEN: store.peekAgentToken(worker.id) ?? '',
  }
  const denied = await cli(args, workerEnv, JSON.stringify(result))
  expect(denied.code).not.toBe(0)
  expect(denied.stderr).toContain('403')
  const reviewInput = await cli(
    ['input', '--dream', draft.id, '--section', 'operations'],
    workerEnv
  )
  expect(reviewInput.code, reviewInput.stderr).toBe(0)
  expect(JSON.parse(reviewInput.stdout).items[0].result.body).toBe(
    'The production API uses port 4310.'
  )
}, 30_000)
