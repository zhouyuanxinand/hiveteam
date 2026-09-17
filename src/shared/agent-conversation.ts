export interface ConversationTurn {
  id: string
  prompt: string
  process: Array<{ id: string; kind: 'commentary' | 'tool'; text: string }>
  answer: string
  status: 'running' | 'complete' | 'interrupted'
}

export interface AgentConversation {
  status: 'ready' | 'pending' | 'unsupported'
  session_id: string | null
  turns: ConversationTurn[]
  truncated: boolean
}
