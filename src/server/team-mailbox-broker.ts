import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  TEAM_MAILBOX_MAX_BYTES,
  TEAM_MAILBOX_REQUEST_TTL_MS,
  type TeamMailboxRequest,
  type TeamMailboxResponse,
  teamMailboxResponseTimeout,
} from '../shared/team-mailbox.js'
import { BadRequestError, ForbiddenError, HttpError } from './http-errors.js'

const REQUEST_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/iu
const POST_ROUTES = new Set([
  '/api/team/grill',
  '/api/team/review/request',
  '/api/team/spawn',
  '/api/team/dismiss',
  '/api/team/message',
  '/api/team/send',
  '/api/team/cancel',
  '/api/team/report',
  '/api/team/status',
  '/api/team/skills/load',
  '/api/team/skills/read',
  '/api/team/goal/report',
  '/api/team/git/commit',
  '/api/team/review/context',
  '/api/team/review/file',
  '/api/team/review/submit',
  '/api/team/tasks/read',
  '/api/team/tasks/write',
  '/api/team/recovery',
])

const readPacket = async (path: string): Promise<TeamMailboxRequest> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > TEAM_MAILBOX_MAX_BYTES) {
      throw new BadRequestError('Invalid team mailbox packet')
    }
    const packet: unknown = JSON.parse(await file.readFile('utf8'))
    if (!packet || typeof packet !== 'object' || Array.isArray(packet))
      throw new BadRequestError('Invalid team mailbox packet')
    return packet as TeamMailboxRequest
  } finally {
    await file.close()
  }
}

export const createTeamMailboxBroker = async (input: {
  root: string
  workspaceId: string
  agentId: string
  token: string
  hivePort: string
  isActive: () => boolean
}) => {
  if (!/^\d+$/u.test(input.hivePort)) throw new BadRequestError('Invalid Hive runtime port')
  const root = join(input.root, randomUUID())
  const requests = join(root, 'requests')
  const responses = join(root, 'responses')
  await mkdir(requests, { recursive: true, mode: 0o700 })
  await mkdir(responses, { mode: 0o700 })
  const requestsReal = await realpath(requests)
  const responsesReal = await realpath(responses)
  const processed = new Map<string, number>()
  let closed = false
  let draining: Promise<void> | undefined

  const forward = async (packet: TeamMailboxRequest, id: string): Promise<TeamMailboxResponse> => {
    if (closed || !input.isActive()) throw new ForbiddenError('This team capability was revoked')
    if (
      packet.id !== id ||
      !Number.isSafeInteger(packet.created_at) ||
      Math.abs(Date.now() - packet.created_at) > TEAM_MAILBOX_REQUEST_TTL_MS
    ) {
      throw new ForbiddenError('This team request is expired or has an invalid identity')
    }
    if (
      typeof packet.path !== 'string' ||
      !packet.path.startsWith('/') ||
      packet.path.startsWith('//')
    ) {
      throw new ForbiddenError('Team route is not allowed')
    }
    const target = new URL(packet.path, 'http://127.0.0.1')
    if (target.origin !== 'http://127.0.0.1' || target.hash)
      throw new ForbiddenError('Team route is not allowed')
    const listPath = `/api/workspaces/${encodeURIComponent(input.workspaceId)}/team`
    const permitted =
      packet.method === 'POST'
        ? POST_ROUTES.has(target.pathname) && !target.search
        : packet.method === 'GET' &&
          (target.pathname === listPath ||
            target.pathname === '/api/team/skills' ||
            target.pathname === '/api/team/staffing' ||
            target.pathname === '/api/team/messages' ||
            target.pathname === '/api/team/deliveries')
    if (!permitted) throw new ForbiddenError('Team route is not allowed')
    let body: string | undefined
    if (packet.method === 'POST') {
      const value: unknown = JSON.parse(packet.body ?? '{}')
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new BadRequestError('Invalid team body')
      const data = value as Record<string, unknown>
      if (data.project_id !== input.workspaceId || data.from_agent_id !== input.agentId) {
        throw new ForbiddenError('Team capability belongs to another member or workspace')
      }
      body = JSON.stringify({ ...data, token: input.token })
    } else {
      const requestedWorkspace = target.searchParams.get('project_id')
      if (requestedWorkspace && requestedWorkspace !== input.workspaceId)
        throw new ForbiddenError('Workspace mismatch')
      if (
        target.pathname === '/api/team/skills' ||
        target.pathname === '/api/team/deliveries' ||
        target.pathname === '/api/team/staffing' ||
        target.pathname === '/api/team/messages'
      )
        target.searchParams.set('project_id', input.workspaceId)
    }
    const response = await fetch(
      `http://127.0.0.1:${input.hivePort}${target.pathname}${target.search}`,
      {
        method: packet.method,
        headers: {
          'content-type': 'application/json',
          'x-hive-agent-id': input.agentId,
          'x-hive-agent-token': input.token,
        },
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: AbortSignal.timeout(teamMailboxResponseTimeout(target.pathname) - 5_000),
      }
    )
    const text = await response.text()
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new HttpError(413, 'Team response is too large')
    return { id, status: response.status, body: text }
  }

  const drain = async () => {
    if (closed) return
    if (
      (await realpath(requests)) !== requestsReal ||
      (await realpath(responses)) !== responsesReal
    ) {
      closed = true
      throw new ForbiddenError('The team mailbox directory changed')
    }
    const entries = await readdir(requests)
    for (const name of entries.filter((entry) => REQUEST_FILE.test(entry)).slice(0, 64)) {
      if (closed) break
      const id = name.slice(0, -5)
      const path = join(requests, name)
      if (processed.has(id)) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
        continue
      }
      let response: TeamMailboxResponse
      try {
        response = await forward(await readPacket(path), id)
      } catch (error) {
        if (
          !(error instanceof HttpError) &&
          !(error instanceof SyntaxError) &&
          !['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error
        response = {
          id,
          status: error instanceof HttpError ? error.statusCode : 400,
          body: JSON.stringify({
            error:
              error instanceof HttpError
                ? error.message
                : 'The team request could not be completed. Check its delivery state before retrying.',
          }),
        }
      }
      processed.set(id, Date.now())
      const pending = join(responses, `${id}.pending`)
      await writeFile(pending, JSON.stringify(response), { flag: 'wx', mode: 0o600 })
      await rename(pending, join(responses, `${id}.json`))
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
    for (const [id, timestamp] of processed) {
      if (Date.now() - timestamp < 60_000) continue
      await unlink(join(responses, `${id}.json`)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      processed.delete(id)
    }
  }
  const timer = setInterval(() => {
    if (closed || draining) return
    draining = drain()
      .catch((error: unknown) => {
        closed = true
        console.error('[hive] team mailbox stopped', error)
      })
      .finally(() => {
        draining = undefined
      })
  }, 30)
  timer.unref()
  return {
    path: root,
    async close() {
      closed = true
      clearInterval(timer)
      await draining
    },
  }
}

export type TeamMailboxBroker = Awaited<ReturnType<typeof createTeamMailboxBroker>>
