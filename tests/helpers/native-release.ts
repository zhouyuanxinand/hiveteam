import { expect, vi } from 'vitest'
import type { ResourceBudgetSnapshot } from '../../src/shared/resource-budget.js'

/** Legacy restart scenarios wait for actual handle cleanup, not only the logical exit summary. */
export const waitForRunResourceRelease = async (baseUrl: string, cookie: string, runId: string) => {
  await vi.waitFor(
    async () => {
      const response = await fetch(`${baseUrl}/api/resources`, { headers: { cookie } })
      expect(response.status).toBe(200)
      const snapshot = (await response.json()) as ResourceBudgetSnapshot
      expect(snapshot.reservations.some((reservation) => reservation.run_id === runId)).toBe(false)
    },
    { timeout: 8000, interval: 25 }
  )
}
