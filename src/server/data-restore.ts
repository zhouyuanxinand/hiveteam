import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { exportBackupDatabase, validateBackupDatabase } from './backup-database.js'
import {
  backupHash,
  backupPath,
  privateBackupDirectory,
  readBackupFile,
  removeOwnedBackupDirectory,
} from './backup-files.js'
import { inspectDataBackup } from './data-backup.js'
import { BadRequestError, ConflictError } from './http-errors.js'

export const restoreDataBackup = async (input: {
  directory: string
  target: string
  manifestVersion: string
  workspaceBindings: Record<string, string>
  confirm: boolean
}) => {
  if (input.confirm !== true)
    throw new BadRequestError(
      'Review the restore preview and explicitly confirm the target and workspace bindings'
    )
  const preview = await inspectDataBackup(input.directory)
  if (preview.manifest_version !== input.manifestVersion)
    throw new ConflictError('Backup manifest changed. Inspect it again before restoring')
  const bindings = new Map<string, string>()
  for (const workspace of preview.manifest.workspaces) {
    const requested = input.workspaceBindings?.[workspace.id]
    if (typeof requested !== 'string' || !isAbsolute(requested))
      throw new BadRequestError(`Explicit absolute workspace binding required: ${workspace.id}`)
    const path = await realpath(requested)
    if (!(await lstat(path)).isDirectory() || [...bindings.values()].includes(path))
      throw new BadRequestError('Workspace bindings must be distinct existing directories')
    bindings.set(workspace.id, path)
  }
  if (Object.keys(input.workspaceBindings).length !== bindings.size)
    throw new BadRequestError('Unknown workspace binding')
  const parent = await realpath(dirname(resolve(input.target))),
    target = join(parent, basename(resolve(input.target)))
  if ((await readdir(parent)).includes(basename(target)))
    throw new ConflictError(
      'Restore target already exists; choose a new directory. Existing data is never overwritten'
    )
  const operationId = randomUUID(),
    stage = join(parent, `.hive-restore-${operationId}`)
  await privateBackupDirectory(stage)
  let complete = false
  try {
    const bytes = await readBackupFile(preview.directory, 'runtime.sqlite', 1024 * 1024 * 1024)
    if (backupHash(bytes) !== preview.manifest.database.sha256)
      throw new ConflictError('Backup changed after preview')
    const sourcePath = join(stage, '.source.sqlite')
    await writeFile(sourcePath, bytes, { flag: 'wx', mode: 0o600 })
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
    try {
      validateBackupDatabase(source)
      exportBackupDatabase(source, join(stage, 'runtime.sqlite'))
    } finally {
      source.close()
    }
    await unlink(sourcePath)
    for (const member of preview.manifest.attachments) {
      const content = await readBackupFile(preview.directory, member.path)
      if (backupHash(content) !== member.sha256)
        throw new ConflictError('Backup attachment changed after preview')
      // Native files remain staged for explicit CLI/session rebind; never overlay a CLI home.
      const path = backupPath(stage, member.target ?? `native-staging/${member.path}`)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, content, { flag: 'wx', mode: 0o600 })
    }
    const db = new Database(join(stage, 'runtime.sqlite'))
    try {
      db.transaction(() => {
        for (const [id, path] of bindings)
          db.prepare('UPDATE workspaces SET path=?,auto_resume=0 WHERE id=?').run(path, id)
        db.exec(`UPDATE workers SET manual_stop=1;
      UPDATE agent_runs SET status='exited',pid=NULL,resume_on_restart=0,ended_at=COALESCE(ended_at,${Date.now()});
      UPDATE workflow_runs SET status='failed',error='Restored: manual reconciliation required',ended_at=COALESCE(ended_at,${Date.now()}) WHERE status IN ('running','pending','queued');
      UPDATE memory_dream_runs SET execution_status='failed',execution_error='Restored: manual reconciliation required' WHERE execution_status IN ('queued','requested');
      UPDATE native_session_attempts SET state='uncertain',error_code='restore_requires_rebind' WHERE state IN ('prepared','allocating','starting','active');
      UPDATE message_deliveries SET state='manual',next_attempt_at=NULL,reason='Restored: reconcile original receipt before continuing' WHERE state IN ('pending','attempting','unknown');
      UPDATE dispatch_verifications SET state='interrupted',error='Restored: verification interrupted' WHERE state IN ('queued','running');`)
        db.exec(
          "UPDATE worker_worktrees SET state='failed',error='Restored: external worktree requires explicit reconciliation'"
        )
        // All workers are explicitly paused. Pending work and receipts retain their identities.
        db.exec('INSERT OR IGNORE INTO resource_agent_pauses SELECT workspace_id,id FROM workers')
        for (const id of bindings.keys())
          db.prepare('INSERT OR IGNORE INTO resource_agent_pauses VALUES(?,?)').run(
            id,
            `${id}:orchestrator`
          )
      })()
      validateBackupDatabase(db)
    } finally {
      db.close()
    }
    const receipt = {
      operation_id: operationId,
      backup_id: preview.manifest.id,
      target,
      workspace_bindings: Object.fromEntries(bindings),
      state: 'restored_to_new_directory',
      agents: 'stopped',
      cli_configuration: 'requires_rebind',
      native_sessions: 'bindings_preserved_requires_explicit_rebind',
      remote_devices: 'requires_pairing',
      old_data: 'unchanged',
      rollback:
        'Stop the restored runtime and restart Hive with the previous HIVE_DATA_DIR. Both directories remain intact.',
    }
    await writeFile(join(stage, 'restore-receipt.json'), JSON.stringify(receipt, null, 2), {
      flag: 'wx',
      mode: 0o600,
    })
    await rename(stage, target)
    complete = true
    return receipt
  } finally {
    if (!complete) await removeOwnedBackupDirectory(parent, stage)
  }
}
