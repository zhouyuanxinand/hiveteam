export const ATTENTION_KINDS = [
  'question',
  'report_delivery',
  'stopped_worker',
  'acceptance',
  'remote_connection',
] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]
export interface AttentionItem {
  id: string
  kind: AttentionKind
  workspace_id: string
  dispatch_id: string | null
  root_dispatch_id: string | null
  agent_id: string | null
  agent_name: string | null
  task_text: string
  detail: string | null
  since: number | null
  state: string
  delivery_id: string | null
  message_id: string | null
}
export interface AttentionPage {
  items: AttentionItem[]
  counts: Record<AttentionKind, number>
  total: number
  filtered_total: number
  next_cursor: string | null
  generated_at: number
}
