import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import chokidar, { type FSWatcher } from 'chokidar'

import type { WorkspaceLanguage } from '../shared/types.js'
import { ensureProtocolFile, ensureTasksFile, getTasksFilePath } from './tasks-file.js'

const DEBOUNCE_MS = 100

export interface TasksFileWatcher {
  close: () => Promise<void>
  start: (workspaceId: string, workspacePath: string, language?: WorkspaceLanguage) => Promise<void>
  stop: (workspaceId: string) => Promise<void>
}

export const createTasksFileWatcher = ({
  onTasksUpdated,
}: {
  onTasksUpdated: (workspaceId: string, content: string) => void
}): TasksFileWatcher => {
  const watchers = new Map<string, FSWatcher>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingOperations = new Map<string, Promise<void>>()
  let closePromise: Promise<void> | undefined

  const clearTimer = (workspaceId: string) => {
    const timer = timers.get(workspaceId)
    if (!timer) return
    clearTimeout(timer)
    timers.delete(workspaceId)
  }

  const emitCurrentContent = async (workspaceId: string, workspacePath: string) => {
    const tasksPath = getTasksFilePath(workspacePath)
    try {
      const content = existsSync(tasksPath) ? await readFile(tasksPath, 'utf8') : ''
      onTasksUpdated(workspaceId, content)
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
      onTasksUpdated(workspaceId, '')
    }
  }

  const stopWatcher = async (workspaceId: string) => {
    clearTimer(workspaceId)
    const watcher = watchers.get(workspaceId)
    watchers.delete(workspaceId)
    await watcher?.close()
  }

  const enqueue = (workspaceId: string, operation: () => Promise<void>) => {
    // A failed caller still receives its rejection; later cleanup or retry must
    // be able to run. Different workspaces retain independent operation queues.
    const previous = pendingOperations.get(workspaceId) ?? Promise.resolve()
    const pending = previous.then(operation, operation)
    pendingOperations.set(workspaceId, pending)
    const settled = () => {
      if (pendingOperations.get(workspaceId) === pending) pendingOperations.delete(workspaceId)
    }
    void pending.then(settled, settled)
    return pending
  }

  const start = (
    workspaceId: string,
    workspacePath: string,
    language: WorkspaceLanguage = 'zh'
  ) => {
    if (closePromise) return Promise.reject(new Error('Tasks file watcher is closed'))
    return enqueue(workspaceId, async () => {
      await stopWatcher(workspaceId)
      ensureTasksFile(workspacePath)
      ensureProtocolFile(workspacePath, language)
      const watcher = chokidar.watch(getTasksFilePath(workspacePath), {
        ignoreInitial: true,
      })
      const scheduleEmit = () => {
        clearTimer(workspaceId)
        timers.set(
          workspaceId,
          setTimeout(() => {
            timers.delete(workspaceId)
            void emitCurrentContent(workspaceId, workspacePath)
          }, DEBOUNCE_MS)
        )
      }
      watcher.on('add', scheduleEmit)
      watcher.on('change', scheduleEmit)
      watcher.on('unlink', scheduleEmit)
      watchers.set(workspaceId, watcher)
      await new Promise<void>((resolve) => watcher.once('ready', () => resolve()))
    })
  }

  return {
    close: () => {
      closePromise ??= (async () => {
        // Queued starts and stops own watchers until they settle. Drain all of
        // them before taking the final watcher snapshot, including on failure.
        const pending = await Promise.allSettled([...pendingOperations.values()])
        await Promise.all([...watchers.keys()].map(stopWatcher))
        const failure = pending.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      })()
      return closePromise
    },
    start,
    stop: (workspaceId) => closePromise ?? enqueue(workspaceId, () => stopWatcher(workspaceId)),
  }
}
