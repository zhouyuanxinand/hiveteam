#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { HIVE_SUPERVISOR_TOKEN_HEADER } from '../server/external-goal-auth.js'
import { readPackageVersion } from '../server/package-version.js'
import { DEFAULT_HIVE_PORT } from './hive-defaults.js'
import { fetchLocalRuntime as fetchLocalRuntimeHttp, type LocalHttpResponse } from './local-http.js'

export const HIVE_MCP_TOOL_NAMES = [
  'hive.list_workspaces',
  'hive.inspect_workspace',
  'hive.start_goal',
  'hive.wait_goal',
  'hive.continue_goal',
  'hive.cancel_goal',
] as const

type HiveMcpToolName = (typeof HIVE_MCP_TOOL_NAMES)[number]
type JsonRecord = Record<string, unknown>

const jsonSchema = (properties: JsonRecord, required: string[] = []) => ({
  additionalProperties: false,
  properties,
  required,
  type: 'object',
})

export const HIVE_MCP_TOOLS = [
  {
    description: 'List local HiveTeam workspaces available for external Supervisor goals.',
    inputSchema: jsonSchema({}),
    name: 'hive.list_workspaces',
  },
  {
    description: 'Inspect a HiveTeam workspace, its Orchestrator, and member roster.',
    inputSchema: jsonSchema({ workspace_id: { type: 'string' } }, ['workspace_id']),
    name: 'hive.inspect_workspace',
  },
  {
    description: 'Deliver an external Supervisor goal to a running workspace Orchestrator.',
    inputSchema: jsonSchema(
      {
        context: {},
        goal: { type: 'string' },
        timeout_hint_ms: { minimum: 0, type: 'number' },
        workspace_id: { type: 'string' },
      },
      ['workspace_id', 'goal']
    ),
    name: 'hive.start_goal',
  },
  {
    description: 'Wait for durable external-goal events after a cursor, with a bounded timeout.',
    inputSchema: jsonSchema(
      {
        cursor: { minimum: 0, type: 'integer' },
        goal_id: { type: 'string' },
        timeout_ms: { minimum: 0, type: 'number' },
      },
      ['goal_id']
    ),
    name: 'hive.wait_goal',
  },
  {
    description: 'Append context to an external goal and deliver it to its Orchestrator.',
    inputSchema: jsonSchema(
      { context: {}, goal_id: { type: 'string' }, message: { type: 'string' } },
      ['goal_id', 'message']
    ),
    name: 'hive.continue_goal',
  },
  {
    description:
      'Cancel an external goal and notify the Orchestrator. This does not auto-cancel member dispatches.',
    inputSchema: jsonSchema({ goal_id: { type: 'string' }, reason: { type: 'string' } }, [
      'goal_id',
      'reason',
    ]),
    name: 'hive.cancel_goal',
  },
] as const

export const parseHiveMcpBaseUrl = (argv: string[], env: NodeJS.ProcessEnv) => {
  const index = argv.indexOf('--base-url')
  if (index !== -1) {
    const value = argv[index + 1]
    if (!value) throw new Error('--base-url requires a value')
    return value.replace(/\/$/u, '')
  }
  if (env.HIVETEAM_MCP_BASE_URL) return env.HIVETEAM_MCP_BASE_URL.replace(/\/$/u, '')
  if (env.HIVE_PORT) return `http://127.0.0.1:${env.HIVE_PORT}`
  return `http://127.0.0.1:${DEFAULT_HIVE_PORT}`
}

const readHttpErrorDetail = async (response: LocalHttpResponse) => {
  const text = await response.text().catch(() => '')
  if (!text.trim()) return `HTTP ${response.status}`
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error
  } catch {
    // A non-JSON error still has useful text.
  }
  return text.trim()
}

const fetchLocalRuntime = async (
  url: string,
  init?: { body?: string; headers?: Record<string, string>; method?: string }
): Promise<LocalHttpResponse> => {
  try {
    return await fetchLocalRuntimeHttp(url, init)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to reach HiveTeam runtime at ${url}: ${reason}`)
  }
}

const getSupervisorToken = async (baseUrl: string) => {
  const response = await fetchLocalRuntime(`${baseUrl}/api/external-goals/session`)
  if (!response.ok) throw new Error(await readHttpErrorDetail(response))
  const body = (await response.json()) as { token?: unknown }
  if (typeof body.token !== 'string' || !body.token) {
    throw new Error('HiveTeam runtime did not issue a Supervisor token')
  }
  return body.token
}

const requestJson = async (
  baseUrl: string,
  path: string,
  init: { body?: string; headers?: Record<string, string>; method?: string } = {}
) => {
  const supervisorToken = await getSupervisorToken(baseUrl)
  const response = await fetchLocalRuntime(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      [HIVE_SUPERVISOR_TOKEN_HEADER]: supervisorToken,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  })
  if (!response.ok) throw new Error(await readHttpErrorDetail(response))
  return response.json() as Promise<unknown>
}

const postJson = (baseUrl: string, path: string, body: JsonRecord) =>
  requestJson(baseUrl, path, { body: JSON.stringify(body), method: 'POST' })

const requireStringArg = (args: JsonRecord, key: string) => {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${key}`)
  return value
}

export const callHiveMcpTool = async (
  toolName: HiveMcpToolName,
  args: JsonRecord = {},
  input: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {}
) => {
  const baseUrl = input.baseUrl ?? parseHiveMcpBaseUrl([], input.env ?? process.env)
  if (toolName === 'hive.list_workspaces') {
    return requestJson(baseUrl, '/api/external-goals/workspaces')
  }
  if (toolName === 'hive.inspect_workspace') {
    const workspaceId = requireStringArg(args, 'workspace_id')
    return requestJson(baseUrl, `/api/external-goals/workspaces/${encodeURIComponent(workspaceId)}`)
  }
  if (toolName === 'hive.start_goal') {
    return postJson(baseUrl, '/api/external-goals/start', {
      ...(args.context !== undefined ? { context: args.context } : {}),
      goal: requireStringArg(args, 'goal'),
      source: 'hiveteam-mcp',
      ...(args.timeout_hint_ms !== undefined ? { timeout_hint_ms: args.timeout_hint_ms } : {}),
      workspace_id: requireStringArg(args, 'workspace_id'),
    })
  }
  if (toolName === 'hive.wait_goal') {
    return postJson(baseUrl, '/api/external-goals/wait', {
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      goal_id: requireStringArg(args, 'goal_id'),
      ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
    })
  }
  if (toolName === 'hive.continue_goal') {
    return postJson(baseUrl, '/api/external-goals/continue', {
      ...(args.context !== undefined ? { context: args.context } : {}),
      goal_id: requireStringArg(args, 'goal_id'),
      message: requireStringArg(args, 'message'),
    })
  }
  if (toolName === 'hive.cancel_goal') {
    return postJson(baseUrl, '/api/external-goals/cancel', {
      goal_id: requireStringArg(args, 'goal_id'),
      reason: requireStringArg(args, 'reason'),
    })
  }
  throw new Error(`Unknown HiveTeam MCP tool: ${toolName}`)
}

interface JsonRpcRequest {
  id?: string | number | null
  method?: unknown
  params?: unknown
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const resultResponse = (id: JsonRpcRequest['id'], result: unknown) => ({
  id,
  jsonrpc: '2.0',
  result,
})

const errorResponse = (id: JsonRpcRequest['id'], code: number, message: string) => ({
  error: { code, message },
  id: id ?? null,
  jsonrpc: '2.0',
})

const toolResult = (result: unknown) => ({
  content: [{ text: JSON.stringify(result), type: 'text' }],
  structuredContent: result,
})

const handleRequest = async (request: JsonRpcRequest, baseUrl: string) => {
  if (typeof request.method !== 'string') {
    return errorResponse(request.id, -32600, 'Invalid JSON-RPC request')
  }
  if (request.method === 'initialize') {
    const params = isRecord(request.params) ? request.params : {}
    return resultResponse(request.id, {
      capabilities: { tools: {} },
      protocolVersion:
        typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
      serverInfo: { name: 'hiveteam-supervisor', version: readPackageVersion() },
    })
  }
  if (request.method === 'ping') return resultResponse(request.id, {})
  if (request.method === 'tools/list') return resultResponse(request.id, { tools: HIVE_MCP_TOOLS })
  if (request.method === 'tools/call') {
    const params = isRecord(request.params) ? request.params : null
    if (!params || typeof params.name !== 'string') {
      return errorResponse(request.id, -32602, 'Missing tool name')
    }
    if (!(HIVE_MCP_TOOL_NAMES as readonly string[]).includes(params.name)) {
      return errorResponse(request.id, -32602, `Unknown HiveTeam MCP tool: ${params.name}`)
    }
    const result = await callHiveMcpTool(
      params.name as HiveMcpToolName,
      {
        ...(isRecord(params.arguments) ? params.arguments : {}),
      },
      { baseUrl }
    )
    return resultResponse(request.id, toolResult(result))
  }
  if (request.id === undefined) return null
  return errorResponse(request.id, -32601, `Unknown method: ${request.method}`)
}

const writeJsonRpc = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)

export const runHiveMcpCommand = async (
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.error('Usage: hive mcp [--base-url http://127.0.0.1:<port>]')
    return
  }
  const baseUrl = parseHiveMcpBaseUrl(argv, env)
  const readline = createInterface({ input: process.stdin, terminal: false })
  for await (const line of readline) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let id: JsonRpcRequest['id']
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const request = isRecord(parsed) ? (parsed as JsonRpcRequest) : {}
      id = request.id
      const response = await handleRequest(request, baseUrl)
      if (response) writeJsonRpc(response)
    } catch (error) {
      writeJsonRpc(
        errorResponse(id, -32603, error instanceof Error ? error.message : String(error))
      )
    }
  }
}

const isMainModule = process.argv[1]
  ? fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  : false

if (isMainModule) {
  void runHiveMcpCommand().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
