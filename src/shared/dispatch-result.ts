/** A worker's declared result, independent of delivery and human acceptance. */
export const reportOutcomes = ['success', 'failed', 'blocked', 'partial'] as const
export type ReportOutcome = (typeof reportOutcomes)[number]

export const isReportOutcome = (value: unknown): value is ReportOutcome =>
  typeof value === 'string' && reportOutcomes.some((outcome) => outcome === value)

export interface DispatchResult {
  reportOutcome: ReportOutcome | null
  reportRevision: number
  acceptedAt: number | null
}
