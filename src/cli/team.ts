import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildProtocolGuide,
  isProtocolGuideTopic,
  PROTOCOL_GUIDE_TOPICS,
} from '../server/hive-team-guidance.js'
import { isReportOutcome, type ReportOutcome } from '../shared/dispatch-result.js'
import { fetchLocalRuntime, type LocalHttpResponse } from './local-http.js'
import { CODE_REVIEW_USAGE, parseCodeReviewArgs } from './team-code-review.js'
import { parseDreamArgs, TEAM_DREAM_USAGE } from './team-dream.js'
import { runTeamGrill, TEAM_GRILL_USAGE } from './team-grill.js'
import { fetchTeamMailbox } from './team-mailbox-client.js'
import {
  MESSAGE_USAGE,
  MESSAGES_USAGE,
  parseMessageArgs,
  parseMessageSequence,
  parseMessagesArgs,
} from './team-messages.js'
import { parseTeamReviewRequestArgs, TEAM_REVIEW_REQUEST_USAGE } from './team-review-request.js'
import { DISMISS_USAGE, parseDismissArgs, parseSpawnArgs, SPAWN_USAGE } from './team-workers.js'

const REQUIRED_ENV_KEYS = [
  'HIVE_PORT',
  'HIVE_PROJECT_ID',
  'HIVE_AGENT_ID',
  'HIVE_AGENT_TOKEN',
] as const

type HiveEnvKey = (typeof REQUIRED_ENV_KEYS)[number]

interface HiveEnv {
  HIVE_PORT: string
  HIVE_PROJECT_ID: string
  HIVE_AGENT_ID: string
  HIVE_AGENT_TOKEN: string
}

const TEAM_USAGE = [
  'Usage:',
  '  team list',
  '  team deliveries',
  ...TEAM_DREAM_USAGE.split('\n').map((line) => `  ${line}`),
  `  ${MESSAGE_USAGE.replace('Usage: ', '')}`,
  `  ${MESSAGES_USAGE.replace('Usage: ', '')}`,
  '  team tasks read',
  '  team recovery [--cursor <cursor>]',
  '  team tasks write --expected-version <version> --stdin',
  ...CODE_REVIEW_USAGE.split('\n').map((line) => `  ${line}`),
  `  ${TEAM_REVIEW_REQUEST_USAGE}`,
  `  ${TEAM_GRILL_USAGE}`,
  '  team git commit --expected-head <sha> "<message>"',
  `  team guide <${PROTOCOL_GUIDE_TOPICS.join('|')}>`,
  '  team send "<worker-name>" "<task>" [--skill <pack/skill>] [--messages]',
  '  team staffing',
  `  ${SPAWN_USAGE.replace('Usage: ', '')}`,
  `  ${DISMISS_USAGE.replace('Usage: ', '')}`,
  '  team skill list',
  '  team skill load (<pack/skill> | --dispatch <dispatch-id>)',
  '  team skill read --dispatch <dispatch-id> <relative-text-path>',
  '  team cancel --dispatch <dispatch-id> "<reason>"',
  '  team goal report --goal <goal-id> --status progress|done|blocked|failed "<body>"',
  '  team goal report --goal <goal-id> --status progress|done|blocked|failed --stdin',
  '  team report "<result>" [--dispatch <dispatch-id>] [--seen-seq <sequence>] [--outcome success|failed|blocked|partial] [--artifact <path>]',
  '  team report --stdin [--dispatch <dispatch-id>] [--seen-seq <sequence>] [--outcome success|failed|blocked|partial] [--artifact <path>]',
  '  team status "<current status>" [--dispatch <id> --progress accepted|progress|waiting_input|waiting_permission|paused|cancelled] [--artifact <path>]',
  '  team status --stdin [--artifact <path>]',
  '',
  'Flags can appear in any order. Use --stdin to pipe long bodies and avoid shell-escaping issues.',
  "Use a quoted heredoc (<<'EOF') so $vars, backticks, and command substitutions stay literal:",
  "  team report --stdin --dispatch <id> <<'EOF'",
  '  ... long report ...',
  '  EOF',
  '',
  'For focused runtime guidance, use team guide <topic>. For the full generated protocol, see .hive/PROTOCOL.md',
].join('\n')

const getHiveEnv = (): HiveEnv => {
  const values = Object.fromEntries(
    REQUIRED_ENV_KEYS.map((key) => [key, process.env[key]])
  ) as Partial<Record<HiveEnvKey, string>>

  if (REQUIRED_ENV_KEYS.some((key) => !values[key])) {
    throw new Error('Missing required HiveTeam environment variables')
  }

  return values as HiveEnv
}

const getBaseUrl = (env: HiveEnv) => `http://127.0.0.1:${env.HIVE_PORT}`

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const describeFetchError = (baseUrl: string, error: unknown) => {
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : ''
  const message = error instanceof Error ? error.message : String(error)
  return `Failed to reach HiveTeam runtime at ${baseUrl}: ${message}${cause}. Check HIVE_PORT and make sure the HiveTeam runtime is still running.`
}

const fetchRuntime = async (
  baseUrl: string,
  path: string,
  init: { body?: string; headers?: Record<string, string>; method?: string }
) => {
  try {
    if (process.env.HIVE_TEAM_MAILBOX)
      return await fetchTeamMailbox(process.env.HIVE_TEAM_MAILBOX, path, init)
    return await fetchLocalRuntime(`${baseUrl}${path}`, init)
  } catch (error) {
    throw new Error(describeFetchError(baseUrl, error))
  }
}

const readHttpErrorDetail = async (response: LocalHttpResponse) => {
  const text = await response.text().catch(() => '')
  const trimmed = text.trim()
  if (!trimmed) return ''

  try {
    const body = JSON.parse(trimmed) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error.trim()
    }
  } catch {
    // Non-JSON responses still carry useful diagnostics in their text body.
  }

  return trimmed
}

const throwHttpError = async (response: LocalHttpResponse): Promise<never> => {
  const detail = await readHttpErrorDetail(response)
  throw new Error(
    detail
      ? `Request failed with status ${response.status}: ${detail}`
      : `Request failed with status ${response.status}`
  )
}

const postJson = async (baseUrl: string, path: string, body: unknown) => {
  const response = await fetchRuntime(baseUrl, path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    await throwHttpError(response)
  }

  return response
}

interface TeamReportResponse {
  dispatch_id: string | null
  forward_error?: string | null
  forwarded?: boolean
  ok: true
}

interface ParsedCancelArgs {
  dispatchId: string
  reason: string
}

export interface ParsedSendArgs {
  messageProtocolVersion?: 1
  skillName: string | undefined
  task: string
  workerName: string
}

const REPORT_USAGE =
  'Usage: team report (<result> | --stdin) [--dispatch <dispatch-id>] [--seen-seq <sequence>] [--outcome success|failed|blocked|partial] [--artifact <path>]'
const STATUS_USAGE =
  'Usage: team status (<current status> | --stdin) [--dispatch <id>] [--progress accepted|progress|waiting_input|waiting_permission|paused|cancelled] [--artifact <path>]'
const CANCEL_USAGE = 'Usage: team cancel --dispatch <dispatch-id> <reason>'
const GUIDE_USAGE = `Usage: team guide <${PROTOCOL_GUIDE_TOPICS.join('|')}>`
const GOAL_REPORT_USAGE =
  'Usage: team goal report --goal <goal-id> --status progress|done|blocked|failed (<body> | --stdin) [--artifact <path>]'
const GOAL_REPORT_STATUSES = new Set(['progress', 'done', 'blocked', 'failed'])
const SEND_USAGE = 'Usage: team send "<worker-name>" "<task>" [--skill <pack/skill>] [--messages]'
const SKILL_USAGE =
  'Usage: team skill (list | load (<pack/skill> | --dispatch <dispatch-id>) | read --dispatch <dispatch-id> <relative-text-path>)'

const usageFor = (command: string) => {
  if (command === 'message') return MESSAGE_USAGE
  if (command === 'review') return `${TEAM_REVIEW_REQUEST_USAGE}\n${CODE_REVIEW_USAGE}`
  if (command === 'status') return STATUS_USAGE
  if (command === 'goal report') return GOAL_REPORT_USAGE
  return REPORT_USAGE
}

const withUsage = (message: string, command: string) => `${message}\n\n${usageFor(command)}`

const readGeneratedProtocolGuide = (topic: string) => {
  const protocolPath = join(process.cwd(), '.hive', 'PROTOCOL.md')
  if (!existsSync(protocolPath)) return null

  const doc = readFileSync(protocolPath, 'utf8')
  const marker = `## Guide: ${topic}`
  const start = doc.indexOf(marker)
  if (start === -1) return null

  const nextGuide = doc.indexOf('\n## Guide:', start + marker.length)
  const reminders = doc.indexOf('\n## In-message reminders', start + marker.length)
  const candidates = [nextGuide, reminders].filter((index) => index !== -1)
  const end = candidates.length === 0 ? doc.length : Math.min(...candidates)
  return doc.slice(start, end).trimEnd()
}

export interface ParsedReportArgs {
  seenSeq?: number
  progressState?:
    | 'accepted'
    | 'progress'
    | 'waiting_input'
    | 'waiting_permission'
    | 'paused'
    | 'cancelled'
  outcome?: ReportOutcome
  artifacts: string[]
  dispatchId: string | undefined
  result: string | null
  useStdin: boolean
}

export interface ParsedGoalReportArgs {
  artifacts: string[]
  goalId: string
  result: string | null
  status: 'progress' | 'done' | 'blocked' | 'failed'
  useStdin: boolean
}

export const parseReportArgs = (args: string[], command = 'report'): ParsedReportArgs => {
  const positionals: string[] = []
  const artifacts: string[] = []
  let dispatchId: string | undefined
  let useStdin = false
  let outcome: ReportOutcome | undefined
  let seenSeq: number | undefined
  let progressState: ParsedReportArgs['progressState']

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--seen-seq') {
      if (command !== 'report' || seenSeq !== undefined)
        throw new Error(withUsage('--seen-seq is only supported once by team report', command))
      seenSeq = parseMessageSequence(args[++index], '--seen-seq')
      continue
    }
    if (arg === '--progress') {
      const value = args[index + 1]
      if (
        command !== 'status' ||
        progressState !== undefined ||
        !value ||
        ![
          'accepted',
          'progress',
          'waiting_input',
          'waiting_permission',
          'paused',
          'cancelled',
        ].includes(value)
      )
        throw new Error(
          withUsage('Invalid --progress value; only team status supports it', command)
        )
      progressState = value as ParsedReportArgs['progressState']
      index += 1
      continue
    }
    if (arg === '--outcome') {
      if (command !== 'report')
        throw new Error(withUsage('--outcome is only supported by team report', command))
      if (outcome !== undefined)
        throw new Error(withUsage('--outcome may only be specified once', command))
      const value = args[index + 1]
      if (!isReportOutcome(value))
        throw new Error(
          withUsage('--outcome must be success, failed, blocked, or partial', command)
        )
      outcome = value
      index += 1
      continue
    }

    // Backward-compatible no-op: reports are interpreted from their text.
    if (arg === '--success' || arg === '--failed') continue

    if (arg === '--stdin') {
      useStdin = true
      continue
    }

    if (arg === '--artifact') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(withUsage('--artifact requires a value', command))
      }
      artifacts.push(next)
      index += 1
      continue
    }

    if (arg === '--dispatch') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(withUsage('--dispatch requires a value', command))
      }
      dispatchId = next
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(withUsage(`Unknown argument: ${arg}`, command))
    }

    positionals.push(arg)
  }

  if (progressState && !dispatchId)
    throw new Error(withUsage('--progress requires --dispatch', command))
  if (seenSeq !== undefined && !dispatchId)
    throw new Error(withUsage('--seen-seq requires --dispatch', command))
  if (useStdin && positionals.length > 0) {
    throw new Error(
      withUsage(
        '--stdin is mutually exclusive with a positional argument; pass the body on stdin or as an argument, not both',
        command
      )
    )
  }

  if (!useStdin && positionals.length === 0) {
    const label = command === 'status' ? '<current status>' : '<result>'
    throw new Error(withUsage(`Missing ${label} (or pass --stdin to read it from stdin)`, command))
  }
  if (positionals.length > 1) {
    const label = command === 'status' ? 'status' : 'result'
    throw new Error(
      withUsage(
        `Expected exactly one ${label} positional, got ${positionals.length}: ${positionals
          .map((value) => JSON.stringify(value))
          .join(', ')}`,
        command
      )
    )
  }

  return {
    result: useStdin ? null : (positionals[0] ?? null),
    artifacts,
    dispatchId,
    useStdin,
    ...(outcome ? { outcome } : {}),
    ...(seenSeq === undefined ? {} : { seenSeq }),
    ...(progressState ? { progressState } : {}),
  }
}

export const parseCancelArgs = (args: string[]): ParsedCancelArgs => {
  const positionals: string[] = []
  let dispatchId: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--dispatch') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--dispatch requires a value\n\n${CANCEL_USAGE}`)
      }
      dispatchId = next
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${CANCEL_USAGE}`)
    }

    positionals.push(arg)
  }

  if (!dispatchId) {
    throw new Error(`Missing --dispatch <dispatch-id>\n\n${CANCEL_USAGE}`)
  }
  if (positionals.length === 0) {
    throw new Error(`Missing <reason>\n\n${CANCEL_USAGE}`)
  }

  const reason = positionals.join(' ').trim()
  if (!reason) {
    throw new Error(`Missing <reason>\n\n${CANCEL_USAGE}`)
  }

  return { dispatchId, reason }
}

export const parseSendArgs = (args: string[]): ParsedSendArgs => {
  const positionals: string[] = []
  let skillName: string | undefined
  let positionalOnly = false
  let messageProtocolVersion: 1 | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (!positionalOnly && arg === '--') {
      positionalOnly = true
      continue
    }
    if (!positionalOnly && arg === '--skill') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`--skill requires a value\n\n${SEND_USAGE}`)
      }
      if (skillName) throw new Error(`--skill may be supplied only once\n\n${SEND_USAGE}`)
      skillName = value
      index += 1
      continue
    }
    if (!positionalOnly && arg === '--messages') {
      if (messageProtocolVersion) throw new Error('--messages may be supplied only once')
      messageProtocolVersion = 1
      continue
    }
    if (!positionalOnly && arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${SEND_USAGE}`)
    }
    positionals.push(arg)
  }

  const [workerName, ...taskParts] = positionals
  const task = taskParts.join(' ').trim()
  if (!workerName || !task || uuidPattern.test(workerName)) throw new Error(SEND_USAGE)
  return {
    skillName,
    task,
    workerName,
    ...(messageProtocolVersion ? { messageProtocolVersion } : {}),
  }
}

export const parseSkillDispatchArgs = (args: string[]) => {
  const positionals: string[] = []
  let dispatchId: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--dispatch') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(SKILL_USAGE)
      if (dispatchId) throw new Error(SKILL_USAGE)
      dispatchId = value
      index += 1
      continue
    }
    if (arg?.startsWith('--')) throw new Error(SKILL_USAGE)
    if (arg) positionals.push(arg)
  }
  return { dispatchId, positionals }
}

export const parseGoalReportArgs = (args: string[]): ParsedGoalReportArgs => {
  const positionals: string[] = []
  const artifacts: string[] = []
  let goalId: string | undefined
  let status: ParsedGoalReportArgs['status'] | undefined
  let useStdin = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--stdin') {
      useStdin = true
      continue
    }
    if (arg === '--goal' || arg === '--status' || arg === '--artifact') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} requires a value\n\n${GOAL_REPORT_USAGE}`)
      }
      if (arg === '--goal') goalId = next
      else if (arg === '--artifact') artifacts.push(next)
      else if (GOAL_REPORT_STATUSES.has(next)) {
        status = next as ParsedGoalReportArgs['status']
      } else {
        throw new Error(
          `--status must be one of: progress, done, blocked, failed\n\n${GOAL_REPORT_USAGE}`
        )
      }
      index += 1
      continue
    }
    if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}\n\n${GOAL_REPORT_USAGE}`)
    positionals.push(arg)
  }

  if (!goalId) throw new Error(`Missing --goal <goal-id>\n\n${GOAL_REPORT_USAGE}`)
  if (!status) throw new Error(`Missing --status <status>\n\n${GOAL_REPORT_USAGE}`)
  if (useStdin && positionals.length > 0) {
    throw new Error(
      `--stdin is mutually exclusive with a positional body; pass the body on stdin or as an argument, not both\n\n${GOAL_REPORT_USAGE}`
    )
  }
  if (!useStdin && positionals.length === 0) {
    throw new Error(
      `Missing <body> (or pass --stdin to read it from stdin)\n\n${GOAL_REPORT_USAGE}`
    )
  }
  if (positionals.length > 1) {
    throw new Error(
      `Expected exactly one body positional, got ${positionals.length}: ${positionals
        .map((value) => JSON.stringify(value))
        .join(', ')}\n\n${GOAL_REPORT_USAGE}`
    )
  }
  return { artifacts, goalId, result: useStdin ? null : (positionals[0] ?? null), status, useStdin }
}

export const readStdinToString = async (
  command = 'report',
  allowEmpty = false
): Promise<string> => {
  if (process.stdin.isTTY) {
    throw new Error(
      withUsage(
        '--stdin requires piped input, but stdin is a TTY. Did you forget to pipe content in?',
        command
      )
    )
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const content = Buffer.concat(chunks).toString('utf8')
  if (!allowEmpty && !content.trim()) {
    throw new Error(withUsage('--stdin received empty input', command))
  }
  return content
}

export const runTeamCommand = async (argv: string[]) => {
  const [command, ...args] = argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(TEAM_USAGE)
    return
  }

  if (command === 'guide') {
    const topic = args[0]
    if (!topic || args.length !== 1 || !isProtocolGuideTopic(topic)) {
      throw new Error(GUIDE_USAGE)
    }
    console.log(readGeneratedProtocolGuide(topic) ?? buildProtocolGuide(topic))
    return
  }

  if (command === 'grill') {
    const env = getHiveEnv()
    await runTeamGrill(
      args,
      {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
      },
      (body) =>
        fetchRuntime(getBaseUrl(env), '/api/team/grill', {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
    )
    return
  }

  if (command === 'dream') {
    const parsed = parseDreamArgs(args)
    const env = getHiveEnv()
    if (parsed.useStdin) {
      const input = await readStdinToString('dream', true)
      if (parsed.action === 'fail') parsed.body.error = input
      else {
        try {
          parsed.body.result = JSON.parse(input)
        } catch {
          throw new Error('Dream result stdin must contain valid JSON')
        }
      }
    }
    const response = await postJson(getBaseUrl(env), `/api/team/dream/${parsed.action}`, {
      ...parsed.body,
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'review') {
    const parsed = ['context', 'file', 'submit'].includes(args[0] ?? '')
      ? parseCodeReviewArgs(args)
      : parseTeamReviewRequestArgs(args)
    const env = getHiveEnv()
    if (parsed.useStdin) parsed.body.summary = await readStdinToString('review')
    const response = await postJson(getBaseUrl(env), `/api/team/review/${parsed.action}`, {
      ...parsed.body,
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'recovery') {
    if (args.length && !(args.length === 2 && args[0] === '--cursor' && args[1]))
      throw new Error('Usage: team recovery [--cursor <cursor>]')
    const env = getHiveEnv()
    const response = await postJson(getBaseUrl(env), '/api/team/recovery', {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      ...(args[1] ? { cursor: args[1] } : {}),
    })
    console.log(JSON.stringify(await response.json()))
    return
  }
  if (command === 'tasks') {
    const [action, flag, version, stdin, ...extra] = args
    if (
      !(action === 'read' && args.length === 1) &&
      !(
        action === 'write' &&
        flag === '--expected-version' &&
        /^sha256:[a-f0-9]{64}$/u.test(version ?? '') &&
        stdin === '--stdin' &&
        !extra.length
      )
    )
      throw new Error(
        'Usage: team tasks read | team tasks write --expected-version <version> --stdin'
      )
    const env = getHiveEnv()
    const response = await postJson(getBaseUrl(env), `/api/team/tasks/${action}`, {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      ...(action === 'write'
        ? { expected_version: version, content: await readStdinToString('tasks', true) }
        : {}),
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'git') {
    const [action, flag, expectedHead, message, ...extra] = args
    if (
      action !== 'commit' ||
      flag !== '--expected-head' ||
      !/^[0-9a-f]{40,64}$/iu.test(expectedHead ?? '') ||
      !message?.trim() ||
      extra.length
    )
      throw new Error('Usage: team git commit --expected-head <sha> "<message>"')
    const env = getHiveEnv()
    const response = await postJson(getBaseUrl(env), '/api/team/git/commit', {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      expected_head: expectedHead,
      message,
    })
    const result = (await response.json()) as {
      commit_sha: string
      index_sync_required?: true
      temporary_cleanup_required?: true
    }
    console.log(JSON.stringify(result))
    if (result.index_sync_required)
      console.error(
        'Commit succeeded. Ask the local user to synchronize this worktree index with git reset --mixed HEAD before verification. Do not retry the commit.'
      )
    if (result.temporary_cleanup_required)
      console.error(
        'Commit succeeded. Temporary Git files require local cleanup; do not retry the commit.'
      )
    return
  }

  if (command === 'list' || command === 'deliveries') {
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await fetchRuntime(
      baseUrl,
      command === 'deliveries'
        ? `/api/team/deliveries?project_id=${encodeURIComponent(env.HIVE_PROJECT_ID)}`
        : `/api/workspaces/${env.HIVE_PROJECT_ID}/team`,
      {
        method: 'GET',
        headers: {
          'x-hive-agent-id': env.HIVE_AGENT_ID,
          'x-hive-agent-token': env.HIVE_AGENT_TOKEN,
        },
      }
    )

    if (!response.ok) {
      await throwHttpError(response)
    }

    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'spawn' || command === 'dismiss') {
    const body = command === 'spawn' ? parseSpawnArgs(args) : parseDismissArgs(args)
    const env = getHiveEnv()
    const response = await postJson(getBaseUrl(env), `/api/team/${command}`, {
      ...body,
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
    })
    console.log(JSON.stringify(await response.json()))
    return
  }
  if (command === 'staffing') {
    if (args.length) throw new Error('Usage: team staffing')
    const env = getHiveEnv()
    const response = await fetchRuntime(
      getBaseUrl(env),
      `/api/team/staffing?project_id=${encodeURIComponent(env.HIVE_PROJECT_ID)}`,
      {
        method: 'GET',
        headers: {
          'x-hive-agent-id': env.HIVE_AGENT_ID,
          'x-hive-agent-token': env.HIVE_AGENT_TOKEN,
        },
      }
    )
    if (!response.ok) await throwHttpError(response)
    console.log(JSON.stringify(await response.json()))
    return
  }
  if (command === 'send') {
    const send = parseSendArgs(args)

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/send', {
      hive_port: env.HIVE_PORT,
      project_id: env.HIVE_PROJECT_ID,
      ...(send.skillName ? { skill_name: send.skillName } : {}),
      ...(send.messageProtocolVersion
        ? { message_protocol_version: send.messageProtocolVersion }
        : {}),
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      to: send.workerName,
      text: send.task,
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'message') {
    const message = parseMessageArgs(args)
    const env = getHiveEnv()
    const response = await postJson(getBaseUrl(env), '/api/team/message', {
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      dispatch_id: message.dispatchId,
      kind: message.kind,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      body: message.useStdin ? await readStdinToString('message') : message.body,
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'messages') {
    const messages = parseMessagesArgs(args)
    const env = getHiveEnv()
    const query = new URLSearchParams({
      project_id: env.HIVE_PROJECT_ID,
      dispatch_id: messages.dispatchId,
      after: String(messages.after),
      limit: String(messages.limit),
    })
    const response = await fetchRuntime(getBaseUrl(env), `/api/team/messages?${query}`, {
      method: 'GET',
      headers: { 'x-hive-agent-id': env.HIVE_AGENT_ID, 'x-hive-agent-token': env.HIVE_AGENT_TOKEN },
    })
    if (!response.ok) await throwHttpError(response)
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'skill') {
    const [subcommand, ...skillArgs] = args
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    if (subcommand === 'list' && skillArgs.length === 0) {
      const response = await fetchRuntime(
        baseUrl,
        `/api/team/skills?project_id=${encodeURIComponent(env.HIVE_PROJECT_ID)}`,
        {
          headers: {
            'x-hive-agent-id': env.HIVE_AGENT_ID,
            'x-hive-agent-token': env.HIVE_AGENT_TOKEN,
          },
          method: 'GET',
        }
      )
      if (!response.ok) await throwHttpError(response)
      console.log(JSON.stringify(await response.json()))
      return
    }
    if (subcommand === 'load') {
      const parsed = parseSkillDispatchArgs(skillArgs)
      if (
        parsed.positionals.length > 1 ||
        (!parsed.dispatchId && parsed.positionals.length !== 1)
      ) {
        throw new Error(SKILL_USAGE)
      }
      if (parsed.dispatchId && parsed.positionals.length > 0) throw new Error(SKILL_USAGE)
      const response = await postJson(baseUrl, '/api/team/skills/load', {
        ...(parsed.dispatchId ? { dispatch_id: parsed.dispatchId } : {}),
        from_agent_id: env.HIVE_AGENT_ID,
        project_id: env.HIVE_PROJECT_ID,
        ...(parsed.positionals[0] ? { skill_name: parsed.positionals[0] } : {}),
        token: env.HIVE_AGENT_TOKEN,
      })
      const payload = (await response.json()) as { instruction_snapshot: string }
      console.log(payload.instruction_snapshot)
      return
    }
    if (subcommand === 'read') {
      const parsed = parseSkillDispatchArgs(skillArgs)
      if (!parsed.dispatchId || parsed.positionals.length !== 1) throw new Error(SKILL_USAGE)
      const response = await postJson(baseUrl, '/api/team/skills/read', {
        dispatch_id: parsed.dispatchId,
        from_agent_id: env.HIVE_AGENT_ID,
        path: parsed.positionals[0],
        project_id: env.HIVE_PROJECT_ID,
        token: env.HIVE_AGENT_TOKEN,
      })
      const payload = (await response.json()) as { content: string }
      console.log(payload.content)
      return
    }
    throw new Error(SKILL_USAGE)
  }

  if (command === 'cancel') {
    const cancel = parseCancelArgs(args)
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    await postJson(baseUrl, '/api/team/cancel', {
      dispatch_id: cancel.dispatchId,
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      reason: cancel.reason,
    })
    return
  }

  if (command === 'goal') {
    const [subcommand, ...goalArgs] = args
    if (subcommand !== 'report') throw new Error(GOAL_REPORT_USAGE)
    const report = parseGoalReportArgs(goalArgs)
    const body = report.useStdin ? await readStdinToString('goal report') : (report.result ?? '')
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/goal/report', {
      artifacts: report.artifacts,
      from_agent_id: env.HIVE_AGENT_ID,
      goal_id: report.goalId,
      project_id: env.HIVE_PROJECT_ID,
      result: body,
      status: report.status,
      token: env.HIVE_AGENT_TOKEN,
    })
    const payload = (await response.json()) as { cursor: number; goal_id: string; status: string }
    console.log(
      JSON.stringify({ cursor: payload.cursor, goal_id: payload.goal_id, status: payload.status })
    )
    return
  }

  if (command === 'status') {
    const report = parseReportArgs(args, 'status')
    const body = report.useStdin ? await readStdinToString('status') : (report.result ?? '')

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/status', {
      ...(report.dispatchId ? { dispatch_id: report.dispatchId } : {}),
      ...(report.progressState ? { progress_state: report.progressState } : {}),
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      result: body,
      artifacts: report.artifacts,
    })
    const payload = (await response.json()) as TeamReportResponse
    if (payload.forwarded === false && payload.forward_error) {
      console.error(
        `HiveTeam recorded the status update, but could not deliver it to Orchestrator in real time: ${payload.forward_error}`
      )
    }
    return
  }

  if (command === 'report') {
    const report = parseReportArgs(args)
    const body = report.useStdin ? await readStdinToString('report') : (report.result ?? '')

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/report', {
      ...(report.outcome ? { outcome: report.outcome } : {}),
      ...(report.seenSeq === undefined ? {} : { seen_seq: report.seenSeq }),
      ...(report.dispatchId ? { dispatch_id: report.dispatchId } : {}),
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      result: body,
      artifacts: report.artifacts,
    })
    const payload = (await response.json()) as TeamReportResponse
    if (payload.forwarded === false && payload.forward_error) {
      console.error(
        `HiveTeam recorded the report, but could not deliver it to Orchestrator in real time: ${payload.forward_error}`
      )
    }
    return
  }

  throw new Error('Unsupported team command')
}

const isMainModule = process.argv[1]
  ? fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  : false

if (isMainModule) {
  void runTeamCommand(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
