import { randomUUID } from 'node:crypto'
import { afterEach } from 'vitest'
import { createResourceBudgetStore } from '../../src/server/resource-budget-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'

const fixtures: Array<{
  db: ReturnType<typeof openRuntimeDatabase>
  beforeClose?: () => Promise<void>
}> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.beforeClose?.()
    fixture.db.close()
  }
})

/** Real SQLite admission for isolated lifecycle fixtures. Production has no default lease. */
export const createTestResourceBudget = (beforeClose?: () => Promise<void>) => {
  const db = openRuntimeDatabase()
  fixtures.push({ db, ...(beforeClose ? { beforeClose } : {}) })
  return createResourceBudgetStore(db, { runtimeInstanceId: randomUUID() })
}
