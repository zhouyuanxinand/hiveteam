import type { DurationStatistics } from '../shared/collaboration-stats.js'

// Nearest-rank percentiles. Missing endpoints (including cancelled work) never
// become zero-duration samples. Zero is valid when both timestamps coincide.
export const summarizeDurations = (values: Array<number | null>): DurationStatistics => {
  const samples = values
    .filter((n): n is number => n !== null && Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b)
  const count = samples.length
  return {
    sample_count: count,
    missing_count: values.length - count,
    mean_ms: count ? samples.reduce((a, b) => a + b, 0) / count : null,
    p50_ms: count ? (samples[Math.ceil(count * 0.5) - 1] ?? null) : null,
    p95_ms: count ? (samples[Math.ceil(count * 0.95) - 1] ?? null) : null,
  }
}
