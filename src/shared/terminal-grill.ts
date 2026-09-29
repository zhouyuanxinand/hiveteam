export interface TerminalGrillHandoff {
  type: 'grill_handoff'
  request_id: string
  status: 'pending' | 'submitted' | 'queued' | 'failed'
  worker_id: string | null
  worker_name: string | null
  created: boolean
  draft_preserved?: boolean
  draft_error?: string
  message: string
}
