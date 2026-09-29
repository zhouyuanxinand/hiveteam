import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class PlatformAlreadyRunningError extends Error {
  constructor(dataDir) {
    super(`Another HiveTeam instance already owns ${dataDir}`)
    this.name = 'PlatformAlreadyRunningError'
  }
}
const lock = (file, dataDir) => {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE')
    return () => db.close()
  } catch (error) {
    db.close()
    if (error?.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(error.errcode & 255)) {
      throw new PlatformAlreadyRunningError(dataDir)
    }
    throw error
  }
}
export const acquirePlatformOwner = (directory) => {
  mkdirSync(directory, { recursive: true })
  const dataDir = realpathSync(directory)
  const close = lock(join(dataDir, 'platform-owner.sqlite'), dataDir)
  try {
    // Do not launch over a runtime started without this supervisor.
    lock(join(dataDir, 'runtime-owner.sqlite'), dataDir)()
  } catch (error) {
    close()
    throw error
  }
  return { dataDir, close }
}
