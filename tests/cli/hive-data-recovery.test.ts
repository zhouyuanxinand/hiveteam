import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const exec = promisify(execFile)
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const cli = fileURLToPath(new URL('../../src/cli/hive.ts', import.meta.url))

test('hive data CLI backs up live WAL data, inspects it and restores stopped identities into a new bound directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-data-cli-'))
  const dataDir = join(root, '原始 数据')
  const store = createRuntimeStore({ dataDir })
  const project = join(root, '原始 项目')
  const rebound = join(root, '恢复 项目')
  mkdirSync(project)
  mkdirSync(rebound)
  try {
    const workspace = store.createWorkspace(project, 'CLI round trip')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = await store.dispatchTask(workspace.id, worker.id, 'Preserve queued history')
    const invoke = (...args: string[]) =>
      exec(process.execPath, ['--import', loader, cli, 'data', ...args], {
        cwd: root,
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          HIVE_DATA_DIR: join(root, 'unused-runtime'),
          HOME: root,
          USERPROFILE: root,
        },
      })
    const output = join(root, '备份')
    const backup = JSON.parse(
      (await invoke('backup', '--data-dir', dataDir, '--output', output)).stdout
    )
    expect(backup.manifest.workspaces).toContainEqual(expect.objectContaining({ id: workspace.id }))
    const preview = JSON.parse((await invoke('inspect', '--backup', output)).stdout)
    const bindings = join(root, 'bindings.json')
    writeFileSync(bindings, JSON.stringify({ [workspace.id]: rebound }))
    const target = join(root, '恢复 数据')
    await expect(
      invoke(
        'restore',
        '--backup',
        output,
        '--target',
        target,
        '--manifest-version',
        'stale',
        '--bindings',
        bindings,
        '--confirm'
      )
    ).rejects.toMatchObject({ code: 1 })
    const restored = JSON.parse(
      (
        await invoke(
          'restore',
          '--backup',
          output,
          '--target',
          target,
          '--manifest-version',
          preview.manifest_version,
          '--bindings',
          bindings,
          '--confirm'
        )
      ).stdout
    )
    expect(restored).toMatchObject({
      state: 'restored_to_new_directory',
      agents: 'stopped',
      old_data: 'unchanged',
    })
    const db = new Database(join(target, 'runtime.sqlite'), { readonly: true })
    try {
      expect(db.prepare('SELECT id,path,auto_resume FROM workspaces').get()).toEqual({
        id: workspace.id,
        path: rebound,
        auto_resume: 0,
      })
      expect(db.prepare('SELECT id,status FROM dispatches').get()).toEqual({
        id: dispatch.id,
        status: 'queued',
      })
      expect(
        db.prepare('SELECT state FROM message_deliveries WHERE dispatch_id=?').all(dispatch.id)
      ).toEqual([{ state: 'manual' }])
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally {
      db.close()
    }
    expect(store.getDispatch(workspace.id, dispatch.id)?.status).toBe('queued')
    expect(store.getWorkspaceSnapshot(workspace.id).summary.path).toBe(project)
    expect(JSON.parse(readFileSync(join(target, 'restore-receipt.json'), 'utf8')).backup_id).toBe(
      backup.manifest.id
    )
  } finally {
    await store.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}, 60000)
