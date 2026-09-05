import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import BetterSqlite3 from 'better-sqlite3'

import { initializeRuntimeDatabase } from './sqlite-schema.js'

export const openRuntimeDatabase = (dataDir?: string): Database => {
  let database: Database
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true })
    database = new BetterSqlite3(join(dataDir, 'runtime.sqlite'))
    // WAL lets the 500ms UI polls read without queueing behind dispatch writes,
    // and NORMAL sync trades an fsync per commit for one per checkpoint. Both
    // settings live in the database file header, so they survive restarts.
    database.pragma('journal_mode = WAL')
    database.pragma('synchronous = NORMAL')
  } else {
    database = new BetterSqlite3(':memory:')
  }
  initializeRuntimeDatabase(database)
  return database
}
