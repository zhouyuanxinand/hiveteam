import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { HiveBackupManifest } from '../shared/data-backup.js'
import { exportBackupDatabase, validateBackupDatabase } from './backup-database.js'
import {
  backupHash,
  backupPath,
  privateBackupDirectory,
  readBackupFile,
  removeOwnedBackupDirectory,
} from './backup-files.js'
import { BadRequestError, ConflictError } from './http-errors.js'
import { nativeBackupProfile } from './native-backup-profile.js'
import { readPackageVersion } from './package-version.js'
import type { Database as SqliteDatabase } from './sqlite.js'
import Database from './sqlite.js'
import { CURRENT_SCHEMA_VERSION } from './sqlite-schema.js'

export const createDataBackup = async (
  source: SqliteDatabase,
  dataDir: string,
  output: string,
  nativeIds: string[] = []
) => {
  const parent = await realpath(dirname(resolve(output))),
    destination = join(parent, resolve(output).slice(dirname(resolve(output)).length + 1))
  if ((await readdir(parent)).includes(destination.slice(parent.length + 1)))
    throw new ConflictError('Backup destination already exists')
  const id = randomUUID(),
    raw = join(parent, `.hive-raw-${id}`),
    stage = join(parent, `.hive-backup-${id}`)
  await privateBackupDirectory(raw)
  let rawDb: SqliteDatabase | undefined,
    complete = false,
    stageCreated = false
  try {
    await privateBackupDirectory(stage)
    stageCreated = true
    await source.backup(join(raw, 'runtime.sqlite'))
    rawDb = new Database(join(raw, 'runtime.sqlite'), { readonly: true, fileMustExist: true })
    validateBackupDatabase(rawDb)
    const records = exportBackupDatabase(rawDb, join(stage, 'runtime.sqlite'))
    const attachments: HiveBackupManifest['attachments'] = []
    let total = 0
    const include = async (
      root: string,
      name: string,
      target: string | null,
      exportName: string,
      prefixBytes?: number
    ) => {
      const bytes = await readBackupFile(root, name, 256 * 1024 * 1024, prefixBytes)
      total += bytes.length
      if (total > 1024 * 1024 * 1024 || attachments.length >= 10000)
        throw new BadRequestError('Backup attachments exceed the 1 GiB / 10000 file limit')
      const path = backupPath(stage, exportName)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
      attachments.push({ path: exportName, target, sha256: backupHash(bytes), bytes: bytes.length })
    }
    for (const row of rawDb
      .prepare('SELECT id,log_bytes FROM dispatch_verifications WHERE log_bytes>0')
      .all() as Array<{ id: string; log_bytes: number }>) {
      if (!/^[a-f0-9-]{36}$/u.test(row.id))
        throw new BadRequestError('Invalid verification attachment identity')
      const path = `verification-logs/${row.id}.log`
      await include(dataDir, path, path, `attachments/${path}`, row.log_bytes)
    }
    const visit = async (name: string) => {
      const path = backupPath(dataDir, name),
        stat = await lstat(path)
      if (stat.isSymbolicLink()) throw new BadRequestError('Skill cache contains a symbolic link')
      if (stat.isDirectory()) {
        for (const file of (await readdir(path)).sort()) await visit(`${name}/${file}`)
      } else await include(dataDir, name, name, `attachments/${name}`)
    }
    for (const row of rawDb
      .prepare('SELECT DISTINCT cache_key FROM skill_pack_releases')
      .all() as Array<{ cache_key: string }>) {
      if (!/^[a-f0-9]{64}$/u.test(row.cache_key))
        throw new BadRequestError('Invalid skill cache key')
      await visit(`skill-packs/cache/${row.cache_key}`)
    }
    const sessions = rawDb
      .prepare(
        'SELECT id AS generation_id,harness,native_id,storage_root FROM native_session_generations WHERE current=1'
      )
      .all() as HiveBackupManifest['native_sessions']
    for (const selected of nativeIds) {
      const session = sessions.find((item) => item.generation_id === selected)
      if (!session?.native_id)
        throw new BadRequestError('Select an explicitly bound native generation')
      if (
        rawDb
          .prepare(
            "SELECT 1 FROM native_session_attempts WHERE generation_id=? AND state IN ('prepared','allocating','starting','active','uncertain')"
          )
          .get(selected)
      )
        throw new ConflictError('Stop and reconcile the native session before backing it up')
      const profile = nativeBackupProfile({ ...session, native_id: session.native_id })
      if (!profile)
        throw Object.assign(
          new ConflictError(
            'Native session backup is unverified for this CLI version; its binding remains an external reference'
          ),
          { code: 'native_backup_unverified' }
        )
      await profile.assertConsistent()
      for (const file of profile.files)
        await include(profile.root, file, null, `native/${selected}/${file}`)
      await profile.assertConsistent()
      session.included = true
    }
    const workspaces = (
      rawDb.prepare('SELECT id,name,path FROM workspaces ORDER BY id').all() as Array<{
        id: string
        name: string
        path: string
      }>
    ).map((workspace) => ({ ...workspace, included: false as const }))
    const external: HiveBackupManifest['external_references'] = (
      rawDb.prepare('SELECT checkout_path FROM worktree_resources').all() as Array<{
        checkout_path: string
      }>
    ).map((item) => ({ kind: 'git_worktree', reference: item.checkout_path, included: false }))
    for (const row of rawDb
      .prepare('SELECT artifacts FROM dispatches WHERE artifacts IS NOT NULL')
      .all() as Array<{ artifacts: string }>) {
      for (const reference of JSON.parse(row.artifacts) as unknown[])
        if (typeof reference === 'string')
          external.push({ kind: 'reported_artifact', reference, included: false })
    }
    rawDb.close()
    rawDb = undefined
    await removeOwnedBackupDirectory(parent, raw)
    const bytes = await readBackupFile(stage, 'runtime.sqlite', 1024 * 1024 * 1024)
    const manifest: HiveBackupManifest = {
      format: 'hive-local-backup',
      format_version: 1,
      id,
      created_at: Date.now(),
      app_version: readPackageVersion(),
      schema_version: CURRENT_SCHEMA_VERSION,
      platform: process.platform,
      architecture: process.arch,
      database: { path: 'runtime.sqlite', bytes: bytes.length, sha256: backupHash(bytes) },
      records,
      attachments,
      workspaces,
      native_sessions: sessions.map((session) => ({
        ...session,
        included: session.included === true,
      })),
      external_references: external,
      credentials: 'excluded_requires_new_authentication_and_pairing',
      cleanup: 'raw_snapshot_removed',
      sensitivity:
        'Natural-language content and optional sessions may contain secrets. Treat this directory as sensitive.',
    }
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      flag: 'wx',
      mode: 0o600,
    })
    await rename(stage, destination)
    complete = true
    return { path: destination, manifest }
  } finally {
    rawDb?.close()
    await removeOwnedBackupDirectory(parent, raw)
    if (stageCreated && !complete) await removeOwnedBackupDirectory(parent, stage)
  }
}

export const inspectDataBackup = async (directory: string) => {
  const root = await realpath(directory)
  const bytes = await readBackupFile(root, 'manifest.json', 4 * 1024 * 1024)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    throw Object.assign(new BadRequestError('Invalid backup manifest JSON'), { cause })
  }
  const manifest = parsed as HiveBackupManifest
  if (
    !manifest ||
    manifest.format !== 'hive-local-backup' ||
    manifest.format_version !== 1 ||
    manifest.schema_version !== CURRENT_SCHEMA_VERSION ||
    manifest.database?.path !== 'runtime.sqlite' ||
    !Array.isArray(manifest.attachments) ||
    !Array.isArray(manifest.workspaces) ||
    !Array.isArray(manifest.native_sessions) ||
    manifest.attachments.length > 10000 ||
    !Array.isArray(manifest.external_references) ||
    manifest.workspaces.some(
      (row) =>
        !row ||
        typeof row.id !== 'string' ||
        typeof row.name !== 'string' ||
        typeof row.path !== 'string' ||
        row.included !== false
    ) ||
    manifest.native_sessions.some(
      (row) =>
        !row ||
        typeof row.generation_id !== 'string' ||
        typeof row.harness !== 'string' ||
        (row.native_id !== null && typeof row.native_id !== 'string') ||
        typeof row.storage_root !== 'string' ||
        typeof row.included !== 'boolean'
    ) ||
    manifest.external_references.some(
      (row) =>
        !row ||
        typeof row.kind !== 'string' ||
        typeof row.reference !== 'string' ||
        row.included !== false
    )
  )
    throw new BadRequestError('Unsupported or incomplete backup manifest')
  const database = await readBackupFile(root, 'runtime.sqlite', 1024 * 1024 * 1024)
  if (
    backupHash(database) !== manifest.database.sha256 ||
    database.length !== manifest.database.bytes
  )
    throw new BadRequestError('Backup database checksum mismatch')
  const seen = new Set<string>(),
    targets = new Set<string>()
  let totalBytes = 0
  for (const member of manifest.attachments) {
    if (
      !member ||
      typeof member.path !== 'string' ||
      typeof member.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(member.sha256) ||
      !Number.isSafeInteger(member.bytes) ||
      member.bytes < 0 ||
      seen.has(member.path) ||
      (!member.path.startsWith('attachments/') && !member.path.startsWith('native/'))
    )
      throw new BadRequestError('Invalid or duplicate backup attachment')
    seen.add(member.path)
    totalBytes += member.bytes
    if (totalBytes > 1024 * 1024 * 1024)
      throw new BadRequestError('Backup attachment budget exceeded')
    if (member.target !== null) {
      if (
        typeof member.target !== 'string' ||
        !/^verification-logs\/[a-f0-9-]{36}\.log$|^skill-packs\/cache\/[a-f0-9]{64}\//u.test(
          member.target
        ) ||
        targets.has(member.target)
      )
        throw new BadRequestError('Invalid attachment restore target')
      backupPath(root, member.target)
      targets.add(member.target)
    }
    const content = await readBackupFile(root, member.path)
    if (content.length !== member.bytes || backupHash(content) !== member.sha256)
      throw new BadRequestError('Backup attachment checksum mismatch')
  }
  const db = new Database(join(root, 'runtime.sqlite'), { readonly: true, fileMustExist: true })
  try {
    validateBackupDatabase(db)
    for (const release of db
      .prepare('SELECT cache_key,content_digest,manifest_json FROM skill_pack_releases')
      .all() as Array<{ cache_key: string; content_digest: string; manifest_json: string }>) {
      const pack = JSON.parse(release.manifest_json) as {
        fileCount: number
        totalBytes: number
        executablePaths: string[]
      }
      const prefix = `skill-packs/cache/${release.cache_key}/`
      const files = manifest.attachments
        .filter((member) => member.target?.startsWith(prefix))
        .map((member) => ({ ...member, relative: (member.target ?? '').slice(prefix.length) }))
        .sort((a, b) => a.relative.localeCompare(b.relative))
      if (
        files.length !== pack.fileCount ||
        files.reduce((sum, file) => sum + file.bytes, 0) !== pack.totalBytes ||
        !Array.isArray(pack.executablePaths)
      )
        throw new BadRequestError('Backup is missing referenced skill cache files')
      const digest = createHash('sha256')
      for (const file of files)
        digest.update(
          `${file.relative}\0${file.bytes}\0${pack.executablePaths.includes(file.relative) ? 0o111 : 0}\0${file.sha256}\0`
        )
      if (`sha256:${digest.digest('hex')}` !== release.content_digest)
        throw new BadRequestError('Backup skill cache digest mismatch')
    }
    const workspaceIds = (
      db.prepare('SELECT id FROM workspaces ORDER BY id').all() as Array<{ id: string }>
    ).map((row) => row.id)
    if (
      JSON.stringify(workspaceIds) !==
      JSON.stringify(manifest.workspaces.map((row) => row?.id).sort())
    )
      throw new BadRequestError('Backup workspace references do not match the database')
    for (const row of db
      .prepare('SELECT id,log_bytes FROM dispatch_verifications WHERE log_bytes>0')
      .all() as Array<{ id: string; log_bytes: number }>) {
      const attachment = manifest.attachments.find(
        (item) => item.target === `verification-logs/${row.id}.log`
      )
      if (!attachment || attachment.bytes !== row.log_bytes)
        throw new BadRequestError('Backup is missing a referenced verification log')
    }
  } finally {
    db.close()
  }
  return {
    directory: root,
    manifest,
    manifest_version: backupHash(bytes),
    requires_workspace_bindings: manifest.workspaces.map((workspace) => workspace.id),
    requires_cli_rebind: true,
    requires_device_pairing: true,
    agents_will_start: false,
    native_sessions_require_rebind: true,
  }
}
