export interface ConversationTurn {
  id: string
  prompt: string
  process: Array<{ id: string; kind: 'commentary' | 'tool'; text: string; truncated?: boolean }>
  truncated?: boolean
  answer: string
  status: 'running' | 'complete' | 'interrupted'
}

export interface AgentConversation {
  run_id?: string
  status: 'ready' | 'pending' | 'unsupported'
  session_id: string | null
  turns: ConversationTurn[]
  truncated: boolean
}
