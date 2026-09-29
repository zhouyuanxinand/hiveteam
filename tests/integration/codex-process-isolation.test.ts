import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { writeNodeCli } from '../helpers/platform-cli.js'
import { startAuthorizedTestServer as startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers = new Set<Awaited<ReturnType<typeof startTestServer>>>()
const directories: string[] = []
afterEach(async () => {
  for (const server of servers) await server.close()
  servers.clear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
})

test('unlisted Codex with isolation support authenticates tool calls, creates an interviewer and resumes', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-codex-process-'))
  directories.push(dataDir)
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath)
  const nativeHome = join(dataDir, 'native-home')
  vi.stubEnv('CODEX_HOME', nativeHome)
  const evidencePath = join(dataDir, 'launch.json')
  const triggerPath = join(dataDir, 'grill-request.json')
  const resultPath = join(dataDir, 'grill-result.json')
  const requestId = randomUUID()
  const command = writeNodeCli(
    dataDir,
    'codex',
    String.raw`
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('Codex CLI\nUsage: codex [OPTIONS]\nOptions:\n      --no-daemon  Run without the shared background server');
  process.exit(0)
}
const resumed = args[0] === 'resume'
const id = resumed ? args[1] : randomUUID()
const root = join(process.env.CODEX_HOME, 'sessions')
mkdirSync(root, { recursive: true })
const file = join(root, 'rollout-' + id + '.jsonl')
if (!resumed) writeFileSync(file, JSON.stringify({type:'session_meta',payload:{id,cwd:process.cwd()}}) + '\n' +
  JSON.stringify({text:'Hive session binding: workspace_id=' + process.env.HIVE_PROJECT_ID + '; agent_id=' + process.env.HIVE_AGENT_ID}) + '\n')
// Model the tool subprocess inheriting an old shared server identity. The real
// team CLI and HTTP boundary must succeed only when launch isolation is applied.
const toolEnv = args.includes('--no-daemon') ? process.env : {
  ...process.env, HIVE_AGENT_TOKEN: 'stale-daemon-token'
}
const team = (command) => JSON.parse(execFileSync(process.execPath, [
  '--import', ${JSON.stringify(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href)},
  ${JSON.stringify(fileURLToPath(new URL('../../src/cli/team.ts', import.meta.url)))},
  ...command
], {env:toolEnv, encoding:'utf8', windowsHide:true, timeout:20000, stdio:['ignore','pipe','pipe']}))
const skills = team(['skill', 'list'])
const main = process.env.HIVE_AGENT_ID.endsWith(':orchestrator')
const agentFile = join(${JSON.stringify(dataDir)}, process.env.HIVE_AGENT_ID.replaceAll(':','_'))
const promptIndex = args.indexOf('--')
const initialPrompt = promptIndex >= 0 ? args[promptIndex + 1] : null
writeFileSync(agentFile + '.launch.json', JSON.stringify({
  args, id, resumed, initialPrompt,
  token_digest: createHash('sha256').update(process.env.HIVE_AGENT_TOKEN).digest('hex')
}))
writeFileSync(agentFile + '.txt', '')
const recordSubmission = (text) => appendFileSync(file,
  JSON.stringify({type:'event_msg',payload:{type:'user_message',message:text}}) + '\n')
if (initialPrompt !== null) recordSubmission(initialPrompt)
if (main) writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({
  args, id, resumed,
  restored: resumed && readFileSync(file, 'utf8').includes(id),
  skill_names: skills.skills.map(skill => skill.qualified_name),
  token_digest: createHash('sha256').update(process.env.HIVE_AGENT_TOKEN).digest('hex')
}))
if (main) setInterval(() => {
  if (!existsSync(${JSON.stringify(triggerPath)})) return
  unlinkSync(${JSON.stringify(triggerPath)})
  try {
    const result = team(['grill', 'Clarify the mail plan', '--skill', 'matt/grill-with-docs', '--request-id', ${JSON.stringify(requestId)}])
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result))
  } catch (error) {
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({error:String(error.stderr ?? error.message), output:String(error.stdout ?? '')}))
  }
}, 50)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
// PTY chunks can end inside a Chinese UTF-8 character. Decode the stream, not
// individual Buffers, so the visible paste count and native receipt stay exact.
process.stdin.setEncoding('utf8')
let pendingInput = ''
process.stdin.on('data', data => {
  appendFileSync(agentFile + '.txt', data)
  pendingInput += data.toString()
  const pasteStart = pendingInput.indexOf('\u001b[200~')
  const pasteEnd = pendingInput.indexOf('\u001b[201~')
  if (pasteStart >= 0 && pasteEnd > pasteStart) process.stdout.write('\u001b[2J\u001b[H› [Pasted Content ' + Array.from(pendingInput.slice(pasteStart + 6, pasteEnd)).length + ' chars]')
  if (data.toString() === '\r') {
    const submitted = pasteStart >= 0 && pasteEnd > pasteStart
      ? pendingInput.slice(pasteStart + 6, pasteEnd)
      : pendingInput.slice(0, -1)
    recordSubmission(submitted)
    pendingInput = ''
    process.stdout.write('\u001b[2J\u001b[H› ')
  }
})
process.stdout.write('FIXTURE_READY\r\n› ')
process.stdin.resume()
`
  )
  const first = await startTestServer({ dataDir })
  servers.add(first)
  const workspace = first.store.createWorkspace(workspacePath, 'Process lifecycle')
  const agentId = `${workspace.id}:orchestrator`
  const pack = join(dataDir, 'pack')
  mkdirSync(join(pack, 'grill-with-docs'), { recursive: true })
  writeFileSync(
    join(pack, 'grill-with-docs/SKILL.md'),
    '---\nname: grill-with-docs\ndescription: Interview\n---\nPINNED-INTERVIEW-BODY'
  )
  const release = await first.store.skills.resolvePack({
    packName: 'matt',
    source: { type: 'local', path: pack },
  })
  const plan = await first.store.skills.plan(workspace.id, {
    action: 'bind',
    packName: 'matt',
    releaseId: release.id,
    profiles: { orchestrator: ['grill-with-docs'], custom: [] },
    nativeExposure: [],
  })
  await first.store.skills.applyPlan(workspace.id, plan.id)
  vi.stubEnv('PATH', dataDir + delimiter + process.env.PATH)
  // Native Windows startup passes one multiline argv value to the Node entry,
  // which the fixture's convenience cmd.exe shim cannot safely receive.
  if (process.platform === 'win32') vi.stubEnv('PATHEXT', `.MJS;${process.env.PATHEXT ?? ''}`)
  first.store.configureAgentLaunch(workspace.id, agentId, {
    command,
    commandPresetId: 'codex',
    presetAugmentationDisabled: true,
    args: ['-c', 'model_reasoning_effort="ultra"'],
    resumeArgsTemplate: 'resume {session_id}',
    sessionIdCapture: {
      source: 'codex_session_jsonl_dir',
      pattern: '~/.codex/sessions/**/*.jsonl',
    },
  })
  const cookie = await getUiCookie(first.baseUrl)
  const response = await fetch(
    `${first.baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`,
    {
      method: 'POST',
      headers: { cookie },
    }
  )
  expect(response.status).toBe(201)
  const run = (await response.json()) as { run_id: string }
  await expect
    .poll(() => first.store.getLiveRun(run.run_id).output, { timeout: 10000 })
    .toContain('FIXTURE_READY')
  const before = JSON.parse(readFileSync(evidencePath, 'utf8'))
  expect(before).toMatchObject({
    args: ['-c', 'model_reasoning_effort="ultra"', '--no-daemon'],
    resumed: false,
    skill_names: ['matt/grill-with-docs'],
  })
  expect(first.store.listWorkers(workspace.id)).toHaveLength(0)
  writeFileSync(triggerPath, '{}')
  await expect
    .poll(
      () => {
        try {
          return JSON.parse(readFileSync(resultPath, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      },
      { timeout: 20000 }
    )
    .toMatchObject({ ok: true, created: true, request_id: requestId })
  const handoff = JSON.parse(readFileSync(resultPath, 'utf8'))
  expect(first.store.listWorkers(workspace.id)).toHaveLength(1)
  await expect
    .poll(() => first.store.getActiveRunByAgentId(workspace.id, handoff.worker_id)?.output, {
      timeout: 15000,
    })
    .toContain('FIXTURE_READY')
  const delivered = () => readFileSync(join(dataDir, `${handoff.worker_id}.txt`), 'utf8')
  const workerLaunch = JSON.parse(
    readFileSync(join(dataDir, `${handoff.worker_id}.launch.json`), 'utf8')
  )
  expect(workerLaunch.args).toContain('--no-daemon')
  expect(workerLaunch.token_digest).not.toBe(before.token_digest)
  let submittedBody: string
  if (process.platform === 'win32') {
    expect(workerLaunch.initialPrompt).toEqual(expect.any(String))
    submittedBody = workerLaunch.initialPrompt
    expect(workerLaunch.args.slice(workerLaunch.args.indexOf('--') + 1)).toEqual([submittedBody])
    const checkpoint = JSON.parse(
      first.store.dispatchDelivery.records.get(handoff.dispatch_id)?.checkpoint ?? '{}'
    )
    expect(checkpoint).toMatchObject({
      wireFormat: 'native-initial-v1',
      wireSha256: createHash('sha256').update(submittedBody).digest('hex'),
      inputSequence: 0,
      submitAttempts: 0,
    })
  } else {
    expect(workerLaunch.initialPrompt).toBeNull()
    await expect.poll(delivered, { timeout: 15000 }).toContain('PINNED-INTERVIEW-BODY')
    await expect.poll(delivered).toContain('\u001b[201~')
    submittedBody = delivered().split('\u001b[200~')[1]?.split('\u001b[201~')[0] ?? ''
    await expect
      .poll(() => first.store.getActiveRunByAgentId(workspace.id, handoff.worker_id)?.output)
      .toContain(`[Pasted Content ${Array.from(submittedBody).length} chars]`)
  }
  expect(submittedBody).toContain('PINNED-INTERVIEW-BODY')
  expect(submittedBody).toContain('Clarify the mail plan')
  expect(submittedBody).toContain(
    `Hive session binding: workspace_id=${workspace.id}; agent_id=${handoff.worker_id}`
  )
  expect(submittedBody).toContain(`[Hive report receipt: ${handoff.dispatch_id}]`)
  await expect
    .poll(
      () => {
        const dispatch = first.store.getDispatch(workspace.id, handoff.dispatch_id)
        return { status: dispatch?.status, last_error: dispatch?.lastError }
      },
      { timeout: 15000 }
    )
    .toEqual({ status: 'submitted', last_error: undefined })
  await expect
    .poll(
      () =>
        first.store.listTerminalRuns(workspace.id).find((run) => run.agent_id === handoff.worker_id)
          ?.thread_id
    )
    .toBeTruthy()
  const workerSession = first.store
    .listTerminalRuns(workspace.id)
    .find((run) => run.agent_id === handoff.worker_id)?.thread_id
  const receipts = readFileSync(
    join(nativeHome, 'sessions', `rollout-${workerSession}.jsonl`),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.type === 'event_msg' && record.payload.type === 'user_message')
  expect(receipts.map((record) => record.payload.message)).toEqual([submittedBody])
  expect(first.store.dispatchDelivery.records.get(handoff.dispatch_id)).toMatchObject({
    state: 'confirmed',
    evidence: 'native_receipt',
  })
  if (process.platform === 'win32') expect(delivered()).toBe('')
  await expect
    .poll(
      () =>
        first.store.listTerminalRuns(workspace.id).find((run) => run.agent_id === agentId)
          ?.thread_id
    )
    .toBe(before.id)
  await first.close()
  servers.delete(first)

  const second = await startTestServer({ dataDir })
  servers.add(second)
  const recovered = await second.store.autoResumeInterruptedAgents({
    hivePort: new URL(second.baseUrl).port,
  })
  expect(recovered).toContainEqual(expect.objectContaining({ ok: true, agentId }))
  const resumedRunId = recovered.find((run) => run.agentId === agentId)?.runId
  if (!resumedRunId) throw new Error('Expected recovered run')
  await expect
    .poll(() => second.store.getLiveRun(resumedRunId).output, { timeout: 10000 })
    .toContain('FIXTURE_READY')
  const after = JSON.parse(readFileSync(evidencePath, 'utf8'))
  expect(after).toMatchObject({
    args: ['resume', before.id, '-c', 'model_reasoning_effort="ultra"', '--no-daemon'],
    id: before.id,
    resumed: true,
    restored: true,
    skill_names: ['matt/grill-with-docs'],
  })
  expect(after.token_digest).not.toBe(before.token_digest)
  expect(
    second.store.listTerminalRuns(workspace.id).find((run) => run.agent_id === agentId)?.thread_id
  ).toBe(before.id)
  rmSync(resultPath)
  writeFileSync(triggerPath, '{}')
  await expect
    .poll(() => JSON.parse(readFileSync(resultPath, 'utf8')), { timeout: 20000 })
    .toMatchObject({ ok: true, worker_id: handoff.worker_id, dispatch_id: handoff.dispatch_id })
  expect(second.store.listWorkers(workspace.id)).toHaveLength(1)
}, 60000)
