import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { TasksSnapshot } from '../shared/tasks.js'
import type { WorkspaceLanguage } from '../shared/types.js'
import { buildProtocolDoc } from './hive-team-guidance.js'
import { BadRequestError, HttpError } from './http-errors.js'
import { recheckRemoteAction } from './remote-action-context.js'

interface TasksFileService {
  readTasks: (workspacePath: string) => string
  readSnapshot: (workspacePath: string) => TasksSnapshot
  writeTasks: (
    workspacePath: string,
    content: string,
    expectedVersion: string,
    assertCurrent?: () => void
  ) => Promise<TasksSnapshot>
}

export const tasksSnapshot = (content: string): TasksSnapshot => ({
  content,
  version: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
})
export class TasksVersionConflict extends HttpError {
  readonly code = 'tasks_version_conflict'
  constructor(readonly current: TasksSnapshot) {
    super(
      409,
      'Tasks changed. Review the current file and merge your draft before retrying with its version.'
    )
  }
}

export const HIVE_DIR_NAME = '.hive'
export const TASKS_FILE_NAME = 'tasks.md'
export const TASKS_RELATIVE_PATH = `${HIVE_DIR_NAME}/${TASKS_FILE_NAME}`
export const PROTOCOL_FILE_NAME = 'PROTOCOL.md'
export const PROTOCOL_RELATIVE_PATH = `${HIVE_DIR_NAME}/${PROTOCOL_FILE_NAME}`
// All HTTP and team writers share the physical path lock, including alias paths.
const pendingWrites = new Map<string, Promise<void>>()

export const getTasksFilePath = (workspacePath: string) =>
  join(workspacePath, HIVE_DIR_NAME, TASKS_FILE_NAME)

export const getProtocolFilePath = (workspacePath: string) =>
  join(workspacePath, HIVE_DIR_NAME, PROTOCOL_FILE_NAME)

const getLegacyTasksFilePath = (workspacePath: string) => join(workspacePath, TASKS_FILE_NAME)

const ensureTasksDir = (workspacePath: string) => {
  mkdirSync(dirname(getTasksFilePath(workspacePath)), { recursive: true })
}

export const ensureTasksFile = (workspacePath: string) => {
  ensureTasksDir(workspacePath)
  const tasksFilePath = getTasksFilePath(workspacePath)
  if (existsSync(tasksFilePath)) {
    return readFileSync(tasksFilePath, 'utf8')
  }

  const legacyTasksFilePath = getLegacyTasksFilePath(workspacePath)
  const content = existsSync(legacyTasksFilePath) ? readFileSync(legacyTasksFilePath, 'utf8') : ''
  writeFileSync(tasksFilePath, content, 'utf8')
  return content
}

/**
 * Always overwrites `.hive/PROTOCOL.md` with the freshly-built protocol doc.
 * The doc is marked auto-generated so user edits are not expected; rewriting
 * on every workspace open means a Hive version bump that changes the rules
 * propagates without manual intervention.
 */
export const ensureProtocolFile = (workspacePath: string, language: WorkspaceLanguage = 'zh') => {
  ensureTasksDir(workspacePath)
  const protocolFilePath = getProtocolFilePath(workspacePath)
  const desired = buildProtocolDoc(language)
  const current = existsSync(protocolFilePath) ? readFileSync(protocolFilePath, 'utf8') : null
  if (current === desired) return desired
  writeFileSync(protocolFilePath, desired, 'utf8')
  return desired
}

export const createTasksFileService = (): TasksFileService => {
  return {
    readTasks(workspacePath) {
      return ensureTasksFile(workspacePath)
    },
    readSnapshot(workspacePath) {
      return tasksSnapshot(ensureTasksFile(workspacePath))
    },
    async writeTasks(workspacePath, content, expectedVersion, assertCurrent) {
      if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 524288)
        throw new BadRequestError('Tasks content must be text of at most 512 KiB')
      if (typeof expectedVersion !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(expectedVersion)) {
        const error = new HttpError(
          428,
          'expected_version is required. Read the tasks snapshot before saving.'
        )
        throw Object.assign(error, { code: 'tasks_version_required' })
      }
      ensureTasksFile(workspacePath)
      const path = realpathSync(getTasksFilePath(workspacePath))
      const key = process.platform === 'win32' ? path.toLowerCase() : path
      const previous = pendingWrites.get(key) ?? Promise.resolve()
      let unlock = () => {}
      const currentWrite = new Promise<void>((resolve) => {
        unlock = resolve
      })
      pendingWrites.set(key, currentWrite)
      const temporary = join(dirname(path), `.tasks-${randomUUID()}.tmp`)
      try {
        await previous
        writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        // Recheck after each bounded Windows sharing-violation wait. Never unlink the
        // destination: readers must observe either the old or the complete new file.
        for (let attempt = 0; ; attempt += 1) {
          recheckRemoteAction()
          assertCurrent?.()
          const current = tasksSnapshot(readFileSync(path, 'utf8'))
          if (current.version !== expectedVersion) throw new TasksVersionConflict(current)
          try {
            renameSync(temporary, path)
            break
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (
              process.platform !== 'win32' ||
              !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') ||
              attempt >= 4
            )
              throw error
            await delay(25 * 2 ** attempt)
          }
        }
      } finally {
        try {
          rmSync(temporary, { force: true })
        } finally {
          unlock()
          if (pendingWrites.get(key) === currentWrite) pendingWrites.delete(key)
        }
      }
      return tasksSnapshot(content)
    },
  }
}

export type { TasksFileService }
