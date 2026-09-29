import { randomUUID } from 'node:crypto'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createManagedExecution } from '../../src/server/managed-execution.js'
import { createResourceBudgetStore } from '../../src/server/resource-budget-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'

const [directory, exitCode] = process.argv.slice(2)
if (!directory || !exitCode) throw new Error('Expected data directory and native exit code')
const db = openRuntimeDatabase(directory)
const resources = createResourceBudgetStore(db, { runtimeInstanceId: randomUUID() })
const reservation = resources.reserve({
  workspaceId: 'fixture',
  executionKey: 'natural-exit',
  kind: 'worker',
})
const manager = createAgentManager()
try {
  const run = await manager.startAgent({
    agentId: 'natural-exit',
    command: process.execPath,
    args: ['-e', `process.exit(${Number(exitCode)})`],
    cwd: directory,
    execution: createManagedExecution(resources, reservation),
  })
  await manager.waitForRunExit?.(run.runId)
  console.log(
    JSON.stringify({
      run: manager.getRun(run.runId),
      occupancy: resources.getSnapshot().occupancy.global,
    })
  )
} finally {
  db.close()
}
// No process.exit: the caller verifies that no native PTY handles keep this
// otherwise idle host alive after the child exits.
