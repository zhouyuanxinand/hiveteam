export const TEAM_MAILBOX_REQUEST_TTL_MS = 30_000
export const TEAM_MAILBOX_MAX_BYTES = 256 * 1024

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
