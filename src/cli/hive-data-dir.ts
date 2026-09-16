import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const resolveDataDir = () =>
  resolve(process.env.HIVE_DATA_DIR || join(homedir(), '.config', 'hive'))
