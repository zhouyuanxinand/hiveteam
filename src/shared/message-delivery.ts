export type DeliveryKind = 'dispatch' | 'report' | 'cancel'
export type DeliveryState =
  | 'pending'
  | 'attempting'
  | 'unknown'
  | 'confirmed'
  | 'manual'
  | 'resolved'
export interface MessageDelivery {
  id: string
  workspace_id: string
  dispatch_id: string
  recipient_id: string
  kind: DeliveryKind
  state: DeliveryState
  evidence: 'none' | 'legacy_unknown' | 'pty_write' | 'native_receipt' | 'worker_ack' | 'manual'
  attempt: number
  run_id: string | null
  session_id: string | null
  created_at: number
  submitted_at: number | null
  confirmed_at: number | null
  next_attempt_at: number | null
  reason: string | null
}
export interface DispatchTimeouts {
  delivery_ms: number
  execution_ms: number
  inactivity_ms: number | null
  cancellation_ms: number
}
export const DEFAULT_DISPATCH_TIMEOUTS: DispatchTimeouts = {
  delivery_ms: 15_000,
  execution_ms: 30 * 60_000,
  inactivity_ms: 5 * 60_000,
  cancellation_ms: 30_000,
}
export type DispatchProgress = 'progress' | 'waiting_input' | 'waiting_permission' | 'paused'
export interface DispatchHealth {
  notification_id: string | null
  dispatch_id: string
  workspace_id: string
  started_at: number | null
  start_source: 'native_receipt' | 'worker_ack' | 'submission_estimate' | null
  last_progress_at: number | null
  progress_source: string | null
  waiting_reason: DispatchProgress | null
  cancellation_requested_at: number | null
  cancellation_confirmed_at: number | null
  cancellation_source: 'worker_ack' | 'manual' | null
  reasons: string[]
  timeouts: DispatchTimeouts
}
export interface DeliveryOverview {
  deliveries: Array<MessageDelivery & { task_text: string; recipient_name: string }>
  health: DispatchHealth[]
  oldest_pending_ms: number
  receipt_latencies_ms: Array<{ delivery_id: string; latency_ms: number }>
}
