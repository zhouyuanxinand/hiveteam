import { expect, test } from 'vitest'
import { summarizeDurations } from '../../src/server/collaboration-statistics.js'

test('nearest-rank percentiles use observed values and retain missing sample coverage', () => {
  const values = Array.from({ length: 20 }, (_, i) => (20 - i) * 100)
  expect(summarizeDurations([...values, null, -1, Number.NaN])).toEqual({
    sample_count: 20,
    missing_count: 3,
    mean_ms: 1050,
    p50_ms: 1000,
    p95_ms: 1900,
  })
  expect(summarizeDurations([null, 0])).toEqual({
    sample_count: 1,
    missing_count: 1,
    mean_ms: 0,
    p50_ms: 0,
    p95_ms: 0,
  })
  expect(summarizeDurations([null])).toEqual({
    sample_count: 0,
    missing_count: 1,
    mean_ms: null,
    p50_ms: null,
    p95_ms: null,
  })
})
