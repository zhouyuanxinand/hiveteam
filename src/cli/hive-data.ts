import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { attachCodexSession } from '../server/codex-session-repair.js'
import { createDataBackup, inspectDataBackup } from '../server/data-backup.js'
import { restoreDataBackup } from '../server/data-restore.js'
import Database from '../server/sqlite.js'

export const HIVE_DATA_USAGE = `hive data backup --data-dir <directory> --output <new-directory>
hive data inspect --backup <backup-directory>
hive data restore --backup <backup-directory> --target <new-directory> --manifest-version <hash> --bindings <json-file> --confirm
hive data attach-codex-session --data-dir <directory> --workspace-id <id> --agent-id <id> --session-id <native-session-uuid>
Session attachment requires a stopped runtime and an explicit native session ID.
Backups contain private natural-language data. CLI configuration and devices require rebinding. Restore never overwrites an existing directory.`
export const runHiveDataCommand = async (argv: string[]) => {
  if (!argv.length || argv.includes('--help')) {
    console.log(HIVE_DATA_USAGE)
    return
  }
  const action = argv[0],
    options = new Map<string, string>()
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--confirm') {
      options.set(flag, 'true')
      continue
    }
    const value = argv[++i]
    if (
      !flag ||
      !value ||
      ![
        '--data-dir',
        '--output',
        '--backup',
        '--target',
        '--manifest-version',
        '--bindings',
        '--workspace-id',
        '--agent-id',
        '--session-id',
      ].includes(flag) ||
      options.has(flag)
    )
      throw new Error(HIVE_DATA_USAGE)
    options.set(flag, value)
  }
  const required = (key: string) => {
    const value = options.get(key)
    if (!value) throw new Error(HIVE_DATA_USAGE)
    return value
  }
  if (action === 'backup') {
    const dataDir = required('--data-dir'),
      db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true, fileMustExist: true })
    try {
      console.log(JSON.stringify(await createDataBackup(db, dataDir, required('--output'))))
    } finally {
      db.close()
    }
  } else if (action === 'attach-codex-session') {
    console.log(
      JSON.stringify(
        attachCodexSession({
          dataDir: required('--data-dir'),
          workspaceId: required('--workspace-id'),
          agentId: required('--agent-id'),
          sessionId: required('--session-id'),
        })
      )
    )
  } else if (action === 'inspect')
    console.log(JSON.stringify(await inspectDataBackup(required('--backup'))))
  else if (action === 'restore') {
    const bindings: unknown = JSON.parse(await readFile(required('--bindings'), 'utf8'))
    if (
      !bindings ||
      typeof bindings !== 'object' ||
      Array.isArray(bindings) ||
      Object.values(bindings).some((value) => typeof value !== 'string')
    )
      throw new Error('Bindings must map workspace IDs to absolute paths')
    console.log(
      JSON.stringify(
        await restoreDataBackup({
          directory: required('--backup'),
          target: required('--target'),
          manifestVersion: required('--manifest-version'),
          workspaceBindings: bindings as Record<string, string>,
          confirm: options.get('--confirm') === 'true',
        })
      )
    )
  } else throw new Error(HIVE_DATA_USAGE)
}
