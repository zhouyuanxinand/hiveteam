export const TEAM_MAILBOX_REQUEST_TTL_MS = 30_000
export const TEAM_MAILBOX_MAX_BYTES = 256 * 1024
// Creating an isolated member includes Git preparation, policy checks and PTY startup.
export const teamMailboxResponseTimeout = (path: string) =>
  path === '/api/team/spawn' || path === '/api/team/review/request' || path === '/api/team/grill'
    ? 120_000
    : 15_000

export interface TeamMailboxRequest {
  id: string
  created_at: number
  method: 'GET' | 'POST'
  path: string
  body?: string
}

export interface TeamMailboxResponse {
  id: string
  status: number
  body: string
}
