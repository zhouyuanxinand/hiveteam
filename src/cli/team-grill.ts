import { randomUUID } from 'node:crypto'
import type { LocalHttpResponse } from './local-http.js'

export const TEAM_GRILL_USAGE =
  'team grill "<requirements brief>" --skill "<pack/grill-skill>" [--request-id <uuid-v4>]'

export const parseTeamGrillArgs = (args: string[]) => {
  const flags = new Map<string, string>()
  const positionals: string[] = []
  for (let index = 0; index < args.length; index++) {
    const value = args[index] ?? ''
    if (value.startsWith('--')) {
      const next = args[++index]
      if (
        !['--skill', '--request-id'].includes(value) ||
        flags.has(value) ||
        !next?.trim() ||
        next.startsWith('--')
      )
        throw new Error(TEAM_GRILL_USAGE)
      flags.set(value, next.trim())
    } else positionals.push(value)
  }
  const skill = flags.get('--skill')
  const requestId = flags.get('--request-id')
  if (
    positionals.length !== 1 ||
    !positionals[0]?.trim() ||
    !skill ||
    (requestId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId))
  )
    throw new Error(TEAM_GRILL_USAGE)
  return { text: positionals[0], skill_name: skill, request_id: requestId ?? randomUUID() }
}

export const runTeamGrill = async (
  args: string[],
  identity: { project_id: string; from_agent_id: string; token: string },
  request: (body: object) => Promise<LocalHttpResponse>
) => {
  const body = parseTeamGrillArgs(args)
  const retry = `Retry the same brief and skill with --request-id ${body.request_id}.`
  // stderr preserves a single machine-readable result on stdout and survives transport failures.
  console.error(`Grill request_id: ${body.request_id}. ${retry}`)
  try {
    const response = await request({ ...body, ...identity })
    const payload = await response.json()
    const result =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : undefined
    if (result?.request_id === body.request_id) console.log(JSON.stringify(result))
    if (!response.ok || result?.ok !== true || result.request_id !== body.request_id) {
      const detail =
        typeof result?.error === 'string' ? result.error : 'The runtime did not confirm the handoff'
      const credentialHelp =
        response.status === 401
          ? ' The runtime rejected the current team credentials. Restart the Orchestrator from Hive to inject fresh credentials before retrying; if rejection continues, inspect its runtime connection. Do not conduct the interview in the main thread.'
          : ''
      throw new Error(`Request failed with status ${response.status}: ${detail}.${credentialHelp}`)
    }
  } catch (error) {
    throw new Error(
      `Grill request ${body.request_id} failed: ${error instanceof Error ? error.message : String(error)}. ${retry}`,
      { cause: error }
    )
  }
}
