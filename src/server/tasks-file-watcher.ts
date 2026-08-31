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
  const pendingStarts = new Map<string, Promise<void>>()

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

  const stop = async (workspaceId: string) => {
    // createWorkspace starts the watcher in the background. Await an in-flight
    // start before closing its watcher; otherwise store.close() can return while
    // chokidar is still opening a handle to the workspace on Windows.
    await pendingStarts.get(workspaceId)
    await stopWatcher(workspaceId)
  }

  const start = (
    workspaceId: string,
    workspacePath: string,
    language: WorkspaceLanguage = 'zh'
  ) => {
    const startPromise = (async () => {
      // This internal stop avoids waiting on the promise currently being built.
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
    })()

    pendingStarts.set(workspaceId, startPromise)
    void startPromise.then(
      () => {
        if (pendingStarts.get(workspaceId) === startPromise) pendingStarts.delete(workspaceId)
      },
      () => {
        if (pendingStarts.get(workspaceId) === startPromise) pendingStarts.delete(workspaceId)
      }
    )
    return startPromise
  }

  return {
    close: async () => {
      // Await starts first so a watcher cannot be registered after the close
      // snapshot. This race is especially visible as EBUSY rmdir failures on
      // Windows when a test or workspace is removed immediately after close.
      while (pendingStarts.size > 0) {
        await Promise.all(Array.from(pendingStarts.values()))
      }
      await Promise.all(Array.from(watchers.keys(), (workspaceId) => stopWatcher(workspaceId)))
    },
    start,
    stop,
  }
}
