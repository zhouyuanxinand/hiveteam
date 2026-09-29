import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import Database from './sqlite.js'

export class RuntimeAlreadyOwnedError extends Error {
  readonly code = 'runtime_already_owned'

  constructor(readonly dataDir: string) {
    super(
      `Another Hive runtime owns this data directory: ${dataDir}. Close it before starting another runtime.`
    )
    this.name = 'RuntimeAlreadyOwnedError'
  }
}

/** This connection owns a rollback-journal EXCLUSIVE transaction until shutdown. */
export const acquireRuntimeOwner = (dataDir?: string) => {
  const runtimeInstanceId = randomUUID()
  if (!dataDir) return { runtimeInstanceId, dataDir: null, close() {} }
  mkdirSync(dataDir, { recursive: true })
  const canonical = realpathSync(dataDir)
  const database = new Database(join(canonical, 'runtime-owner.sqlite'), { timeout: 0 })
  try {
    database.pragma('journal_mode = DELETE')
    database.pragma('locking_mode = EXCLUSIVE')
    database.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    database.close()
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
    ) {
      throw new RuntimeAlreadyOwnedError(canonical)
    }
    throw error
  }
  return {
    runtimeInstanceId,
    dataDir: canonical,
    close() {
      if (!database.open) return
      if (database.inTransaction) database.exec('ROLLBACK')
      database.close()
    },
  }
}

export type RuntimeOwner = ReturnType<typeof acquireRuntimeOwner>
