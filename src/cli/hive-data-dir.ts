import { homedir } from 'node:os'
import { join } from 'node:path'

export const resolveDataDir = () => process.env.HIVE_DATA_DIR || join(homedir(), '.config', 'hive')
