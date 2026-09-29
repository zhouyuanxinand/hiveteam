import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { buildAgentStartupInstructions } from '../../src/server/agent-startup-instructions.js'
import { buildRecoverySummary } from '../../src/server/recovery-summary.js'
import { setWorkspaceMemoryEnabled } from '../../src/server/team-memory-digest.js'
import { discoverWorkspaceDocuments } from '../../src/shared/workspace-documents.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers = new Set<Awaited<ReturnType<typeof startAuthorizedTestServer>>>()
const roots: string[] = []
afterEach(async () => {
  for (const server of servers) await server.close()
  servers.clear()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), 'hive-initial-prompt-')))
      throw new Error('Unexpected fixture directory')
    rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
})

interface LaunchEvidence {
  args: string[]
  prompt: string | null
  sessionId: string
  resumedId: string | null
  historyPath: string
  stdinPath: string
}

test.skipIf(process.platform !== 'win32')(
  'native startup argv preserves the complete instructions and resumes without repeating them',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-initial-prompt-'))
    roots.push(root)
    const workspacePath = join(root, '项目 with spaces 🐝')
    mkdirSync(workspacePath)
    const documentName = '需求说明 & 引用.md'
    writeFileSync(
      join(workspacePath, documentName),
      'Reference document; contents are not startup instructions.\n'
    )
    vi.stubEnv('CODEX_HOME', join(root, 'native-home'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    const command = join(root, 'codex.js')
    writeFileSync(
      command,
      `import { runInitialPromptCli } from ${JSON.stringify(new URL('../fixtures/codex-initial-prompt-cli.mjs', import.meta.url).href)}\nrunInitialPromptCli(${JSON.stringify(root)})\n`
    )
    const dataDir = join(root, 'data')
    const first = await startAuthorizedTestServer({ dataDir })
    servers.add(first)
    const workspace = first.store.createWorkspace(
      workspacePath,
      '启动 "引号" & | ^ %PATH% !bang! < > 🐝'
    )
    const agent = first.store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!agent) throw new Error('Expected the Orchestrator')
    setWorkspaceMemoryEnabled(first.store.settings, workspace.id, true)
    const memoryBody = '团队约定：保留完整中文与换行 🐝\n"quoted" & | ^ %PATH% !bang! < >'
    const memory = first.store.memory.create(workspace.id, { kind: 'fact', body: memoryBody })
    first.store.memory.update(workspace.id, memory.id, { pinned: true })
    first.store.configureAgentLaunch(workspace.id, agent.id, {
      command,
      commandPresetId: 'codex',
      args: ['-c', 'model_reasoning_effort="ultra"'],
    })
    const documents = await discoverWorkspaceDocuments(workspace.path)
    const launches = () =>
      readFileSync(join(root, 'launches.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as LaunchEvidence)
    const start = async (server: typeof first) => {
      const cookie = await getUiCookie(server.baseUrl)
      const response = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${agent.id}/start`,
        { method: 'POST', headers: { cookie } }
      )
      expect(response.status, await response.clone().text()).toBe(201)
      const { run_id: runId } = (await response.json()) as { run_id: string }
      await expect
        .poll(() => server.store.getLiveRun(runId).output, { timeout: 10000 })
        .toContain('INITIAL_PROMPT_READY')
      return runId
    }
    const initialRunId = await start(first)
    const memoryContext = first.store.memory
      .contexts(workspace.id)
      .find((item) => item.context === 'startup')
    if (!memoryContext) throw new Error('Expected the persisted startup memory context')
    expect(memoryContext).toMatchObject({ run_id: initialRunId, agent_id: agent.id })
    expect(memoryContext.candidates).toContainEqual(
      expect.objectContaining({ memory_id: memory.id, selected: true, body: memoryBody })
    )
    const expected = buildAgentStartupInstructions({
      workspace,
      agent,
      documents,
      memoryDigest: memoryContext.digest,
    })
    const initial = launches()[0]
    if (!initial) throw new Error('Expected the native CLI launch receipt')
    expect(initial.prompt).toBe(expected)
    expect(initial.args.at(-1)).toBe(expected)
    expect(initial.args).toContain('model_reasoning_effort="ultra"')
    expect(initial.prompt).toContain(documentName)
    const userMessages = () =>
      readFileSync(initial.historyPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((record) => record.type === 'response_item' && record.payload.role === 'user')
        .map((record) => record.payload.content[0].text)
    expect(userMessages()).toEqual([expected])
    await expect
      .poll(
        () =>
          first.store.listTerminalRuns(workspace.id).find((run) => run.agent_id === agent.id)
            ?.thread_id,
        { timeout: 5000 }
      )
      .toBe(initial.sessionId)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(readFileSync(initial.stdinPath, 'utf8')).not.toContain('\u001b[200~')
    expect(userMessages()).toEqual([expected])
    await first.close()
    servers.delete(first)
    const second = await startAuthorizedTestServer({ dataDir })
    servers.add(second)
    await start(second)
    const resumed = launches()[1]
    if (!resumed) throw new Error('Expected the resumed CLI launch receipt')
    expect(resumed).toMatchObject({
      resumedId: initial.sessionId,
      sessionId: initial.sessionId,
      prompt: null,
    })
    expect(resumed.args).toContain('resume')
    expect(userMessages()).toEqual([expected])
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(readFileSync(resumed.stdinPath, 'utf8')).not.toContain('\u001b[200~')
    expect(
      second.store.listTerminalRuns(workspace.id).find((run) => run.agent_id === agent.id)
        ?.thread_id
    ).toBe(initial.sessionId)
  },
  35000
)

test.skipIf(process.platform !== 'win32')(
  'a prior run without a native session delivers its complete recovery context once through argv',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-initial-prompt-'))
    roots.push(root)
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath)
    vi.stubEnv('CODEX_HOME', join(root, 'native-home'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    const command = join(root, 'codex.js')
    writeFileSync(
      command,
      `import { runInitialPromptCli } from ${JSON.stringify(new URL('../fixtures/codex-initial-prompt-cli.mjs', import.meta.url).href)}\nrunInitialPromptCli(${JSON.stringify(root)})\n`
    )
    const failureFlag = join(root, 'exit-before-session')
    writeFileSync(failureFlag, '')
    const server = await startAuthorizedTestServer({ dataDir: join(root, 'data') })
    servers.add(server)
    const workspace = server.store.createWorkspace(workspacePath, '恢复中文 "quoted" 🐝')
    const agent = server.store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!agent) throw new Error('Expected the Orchestrator')
    server.store.configureAgentLaunch(workspace.id, agent.id, {
      command,
      commandPresetId: 'codex',
      args: [],
    })
    const cookie = await getUiCookie(server.baseUrl)
    const start = async () => {
      const response = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${agent.id}/start`,
        { method: 'POST', headers: { cookie } }
      )
      expect(response.status, await response.clone().text()).toBe(201)
      return ((await response.json()) as { run_id: string }).run_id
    }
    const failedRunId = await start()
    await expect
      .poll(() => server.store.getLiveRun(failedRunId).status, { timeout: 10000 })
      .toBe('exited')
    expect(server.store.getLiveRun(failedRunId).output).toContain(
      'INITIAL_PROMPT_ABORTED_BEFORE_SESSION'
    )
    expect(server.store.listAgentRuns(agent.id)).toContainEqual(
      expect.objectContaining({ runId: failedRunId, status: 'exited' })
    )
    expect(await server.store.readAgentConversation(workspace.id, agent.id)).toMatchObject({
      status: 'pending',
      session_id: null,
    })
    await expect
      .poll(() => server.store.resources.getSnapshot().occupancy.global, { timeout: 10000 })
      .toBe(0)
    unlinkSync(failureFlag)
    const tasksContent = '# 接力任务\n\n- [ ] 恢复 "多行" & 符号 🐝\n'
    mkdirSync(join(workspacePath, '.hive'), { recursive: true })
    writeFileSync(join(workspacePath, '.hive/tasks.md'), tasksContent)
    const expected = buildRecoverySummary({
      workspace,
      agent: server.store.getWorkspaceSnapshot(workspace.id).agents[0] ?? agent,
      workers: [],
      messages: server.store.listMessagesForRecovery(workspace.id, Date.now() - 3600000),
      openDispatches: [],
      tasksContent,
    })
    const recoveredRunId = await start()
    await expect
      .poll(() => server.store.getLiveRun(recoveredRunId).output, { timeout: 10000 })
      .toContain('INITIAL_PROMPT_READY')
    const launch = JSON.parse(
      readFileSync(join(root, 'launches.jsonl'), 'utf8').trim()
    ) as LaunchEvidence
    expect(launch.prompt).toBe(expected)
    expect(launch.resumedId).toBeNull()
    const userMessages = () =>
      readFileSync(launch.historyPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((record) => record.type === 'response_item' && record.payload.role === 'user')
        .map((record) => record.payload.content[0].text)
    expect(userMessages()).toEqual([expected])
    await expect
      .poll(
        () =>
          server.store.listTerminalRuns(workspace.id).find((run) => run.run_id === recoveredRunId)
            ?.thread_id,
        { timeout: 5000 }
      )
      .toBe(launch.sessionId)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(readFileSync(launch.stdinPath, 'utf8')).not.toContain('\u001b[200~')
    expect(userMessages()).toEqual([expected])
  },
  30000
)
