import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  TEAM_MAILBOX_MAX_BYTES,
  type TeamMailboxRequest,
  type TeamMailboxResponse,
} from '../shared/team-mailbox.js'
import type { LocalHttpRequestInit, LocalHttpResponse } from './local-http.js'

/** A sandbox can report without gaining access to any local TCP service. */
export const fetchTeamMailbox = async (
  root: string,
  path: string,
  init: LocalHttpRequestInit = {}
): Promise<LocalHttpResponse> => {
  if (init.method && init.method !== 'POST' && init.method !== 'GET') {
    throw new Error('The team mailbox only supports GET and POST')
  }
  const id = randomUUID()
  const request: TeamMailboxRequest = {
    id,
    created_at: Date.now(),
    method: init.method === 'POST' ? 'POST' : 'GET',
    path,
    ...(init.body !== undefined ? { body: init.body } : {}),
  }
  const payload = JSON.stringify(request)
  if (Buffer.byteLength(payload) > TEAM_MAILBOX_MAX_BYTES)
    throw new Error('Team request is too large')
  const pending = join(root, 'requests', `${id}.pending`)
  await writeFile(pending, payload, { flag: 'wx', mode: 0o600 })
  await rename(pending, join(root, 'requests', `${id}.json`))
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    let response: TeamMailboxResponse | undefined
    try {
      response = JSON.parse(
        await readFile(join(root, 'responses', `${id}.json`), 'utf8')
      ) as TeamMailboxResponse
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (response) {
      if (
        response.id !== id ||
        typeof response.body !== 'string' ||
        !Number.isInteger(response.status)
      ) {
        throw new Error('Invalid team mailbox response')
      }
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        text: async () => response.body,
        json: async () => JSON.parse(response.body) as unknown,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('The team mailbox did not confirm delivery. Check the agent run before retrying.')
}
