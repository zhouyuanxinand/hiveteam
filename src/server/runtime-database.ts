import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from './sqlite.js'

import { initializeRuntimeDatabase } from './sqlite-schema.js'

export const openRuntimeDatabase = (dataDir?: string): Database => {
  let database: Database
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true })
    database = new Database(join(dataDir, 'runtime.sqlite'))
    // WAL lets the 500ms UI polls read without queueing behind dispatch writes,
    // and NORMAL sync trades an fsync per commit for one per checkpoint. Both
    // settings live in the database file header, so they survive restarts.
  } else {
    database = new Database(':memory:')
  }
  try {
    if (dataDir) {
      database.pragma('journal_mode = WAL')
      database.pragma('synchronous = NORMAL')
    }
    initializeRuntimeDatabase(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
