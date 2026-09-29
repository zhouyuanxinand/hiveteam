import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect } from 'vitest'
import Database from '../../src/server/sqlite.js'
import { createTeamMailboxBroker } from '../../src/server/team-mailbox-broker.js'
import type { TeamReviewView } from '../../src/shared/team-review.js'
import { createCodeReviewFixture } from './code-review-fixture.js'

const script =
  'if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.on("data",data=>console.log("INPUT:"+data));console.log("REVIEW_READY:"+JSON.stringify({cwd:process.cwd(),id:process.env.HIVE_AGENT_ID}));'
export const createTeamReviewFixture = async () => {
  const base = await createCodeReviewFixture(true)
  const actor = `${base.workspace.id}:orchestrator`
  const config = { command: process.execPath, args: ['-e', script] }
  base.server.store.configureAgentLaunch(base.workspace.id, actor, config)
  await base.server.store.startAgent(base.workspace.id, actor, {
    hivePort: new URL(base.server.baseUrl).port,
  })
  await expect
    .poll(() => base.server.store.getActiveRunByAgentId(base.workspace.id, actor)?.output, {
      timeout: 15000,
    })
    .toContain('REVIEW_READY:')
  const preset = base.server.store.settings.createCommandPreset({
    ...config,
    displayName: 'Review fixture',
    env: {},
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: null,
  })
  base.server.store.workerLifecycle.updatePolicy(base.workspace.id, {
    enabled: true,
    allowed_command_preset_ids: [preset.id],
    max_ephemeral_workers: 2,
  })
  const brokers: Array<Awaited<ReturnType<typeof createTeamMailboxBroker>>> = []
  const post = (path: string, body: object, agentId = actor) =>
    fetch(base.server.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        project_id: base.workspace.id,
        from_agent_id: agentId,
        token: base.server.store.peekAgentToken(agentId),
      }),
    })
  const requestBody = (extra: object = {}) => ({
    request_id: randomUUID(),
    dispatch_id: base.dispatch.id,
    focus: 'Review the committed API contract',
    command_preset_id: preset.id,
    ...extra,
  })
  const create = async (extra: object = {}) => {
    const response = await post('/api/team/review/request', requestBody(extra))
    expect(response.status, await response.clone().text()).toBe(201)
    return (await response.json()) as TeamReviewView
  }
  const cli = (agentId: string, args: string[], mailbox = '') =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'bin/team', ...args], {
        windowsHide: true,
        timeout: 90000,
        env: {
          ...process.env,
          HIVE_PROJECT_ID: base.workspace.id,
          HIVE_AGENT_ID: agentId,
          HIVE_AGENT_TOKEN: base.server.store.peekAgentToken(agentId) ?? '',
          HIVE_PORT: new URL(base.server.baseUrl).port,
          HIVE_TEAM_MAILBOX: mailbox,
        },
      })
      let stdout = '',
        stderr = ''
      child.stdout?.setEncoding('utf8').on('data', (text) => {
        stdout += text
      })
      child.stderr?.setEncoding('utf8').on('data', (text) => {
        stderr += text
      })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })
  return {
    ...base,
    get server() {
      return base.server
    },
    get cookie() {
      return base.cookie
    },
    actor,
    preset,
    post,
    requestBody,
    create,
    cli,
    db<T>(run: (db: Database) => T) {
      const db = new Database(join(base.dataDir, 'runtime.sqlite'))
      try {
        return run(db)
      } finally {
        db.close()
      }
    },
    async mailbox(agentId = actor) {
      const broker = await createTeamMailboxBroker({
        root: join(base.root, randomUUID()),
        workspaceId: base.workspace.id,
        agentId,
        token: base.server.store.peekAgentToken(agentId) ?? '',
        hivePort: new URL(base.server.baseUrl).port,
        isActive: () => true,
      })
      brokers.push(broker)
      return broker.path
    },
    async close() {
      for (const broker of brokers) await broker.close()
      await base.close()
    },
  }
}
