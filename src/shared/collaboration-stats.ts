export type CollaborationPeriod = '7' | '30' | 'all'

export interface DurationStatistics {
  sample_count: number
  missing_count: number
  mean_ms: number | null
  p50_ms: number | null
  p95_ms: number | null
}

export interface CollaborationStatistics {
  period: CollaborationPeriod
  since: number | null
  generated_at: number
  counts: {
    root_tasks: number
    dispatches: number
    messages: number
    reworks: number
    delivery_attempts: number
    retries: number
  }
  durations: Record<
    'queue' | 'execution' | 'report_submission' | 'acceptance_to_integration',
    DurationStatistics
  >
  payload: {
    total_bytes: number | null
    measured_attempts: number
    unmeasured_attempts: number
    pending_deliveries: number
  }
}
