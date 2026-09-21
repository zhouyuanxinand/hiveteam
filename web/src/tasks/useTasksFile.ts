import { useCallback, useEffect, useRef, useState } from 'react'
import type { TasksSnapshot } from '../../../src/shared/tasks.js'
import { getWorkspaceTasks, saveWorkspaceTasks } from '../api.js'
import {
  appendChildTaskAtLine,
  deleteTaskLine,
  toggleTaskLine,
  updateTaskTextAtLine,
} from './task-markdown.js'
import { TasksConflictError } from './tasks-api.js'

export const useTasksFile = (workspaceId: string | null, demoContent?: string) => {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [remote, setRemote] = useState<TasksSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const base = useRef<TasksSnapshot | null>(null)
  const draft = useRef('')
  const remoteRef = useRef<TasksSnapshot | null>(null)
  const writing = useRef(false)
  const epoch = useRef(0)
  const changeRemote = useCallback((snapshot: TasksSnapshot | null) => {
    remoteRef.current = snapshot
    setRemote(snapshot)
  }, [])
  const receive = useCallback(
    (snapshot: TasksSnapshot) => {
      if (base.current?.version === snapshot.version) return
      if (
        !base.current ||
        draft.current === base.current.content ||
        draft.current === snapshot.content
      ) {
        base.current = snapshot
        draft.current = snapshot.content
        setContent(snapshot.content)
        changeRemote(null)
      } else changeRemote(snapshot)
    },
    [changeRemote]
  )
  useEffect(() => {
    const current = ++epoch.current
    base.current = null
    draft.current = ''
    writing.current = false
    setContent('')
    setLoaded(false)
    changeRemote(null)
    setError(null)
    if (!workspaceId) return
    let stopped = false,
      socketReceived = false
    void getWorkspaceTasks(workspaceId)
      .then((snapshot) => {
        if (stopped || current !== epoch.current || socketReceived) return
        receive(snapshot)
        setLoaded(true)
      })
      .catch((cause: unknown) => {
        if (!stopped && !socketReceived)
          setError(cause instanceof Error ? cause.message : String(cause))
      })
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/tasks/${workspaceId}`)
    socket.onmessage = (event) => {
      if (stopped) return
      const payload = JSON.parse(event.data) as Partial<TasksSnapshot> & {
        type: string
        error?: string
      }
      if (payload.type === 'tasks-error') {
        setError(payload.error ?? 'Tasks could not be read')
        return
      }
      if (
        (payload.type === 'tasks-snapshot' || payload.type === 'tasks-updated') &&
        typeof payload.content === 'string' &&
        typeof payload.version === 'string'
      ) {
        socketReceived = true
        receive({ content: payload.content, version: payload.version })
        setLoaded(true)
      }
    }
    return () => {
      stopped = true
      epoch.current++
      socket.close()
    }
  }, [workspaceId, receive, changeRemote])
  const change = (value: string) => {
    draft.current = value
    setContent(value)
  }
  const save = async (value: string) => {
    if (!workspaceId || demoContent !== undefined) return
    if (!base.current || writing.current) {
      const message = 'Wait for the current tasks request to finish; your draft is preserved.'
      setError(message)
      throw new Error(message)
    }
    const current = epoch.current,
      expected = base.current.version
    writing.current = true
    setError(null)
    try {
      const saved = await saveWorkspaceTasks(workspaceId, {
        content: value,
        expected_version: expected,
      })
      if (current !== epoch.current) return
      if (base.current.version !== expected && base.current.version !== saved.version) return
      base.current = saved
      if (remoteRef.current?.version === saved.version) changeRemote(null)
      if (draft.current === value) change(saved.content)
    } catch (cause) {
      if (current === epoch.current) {
        if (cause instanceof TasksConflictError) changeRemote(cause.current)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      throw cause
    } finally {
      if (current === epoch.current) writing.current = false
    }
  }
  const transform = async (operation: (value: string) => string) => {
    if (!workspaceId || demoContent !== undefined) return
    const next = operation(draft.current)
    if (next === draft.current) return
    change(next)
    await save(next)
  }
  return {
    content: demoContent ?? content,
    loaded: demoContent !== undefined || loaded,
    hasConflict: demoContent === undefined && remote !== null,
    remoteContent: remote?.content ?? null,
    error,
    onChange: demoContent === undefined ? change : (_value: string) => {},
    onSave: () => save(draft.current),
    onReload: () => {
      const snapshot = remoteRef.current ?? base.current
      if (!snapshot) return
      base.current = snapshot
      change(snapshot.content)
      changeRemote(null)
      setError(null)
    },
    // Explicitly acknowledges comparison/merge; the following save still uses a checked version.
    onKeepLocal: () => {
      if (remoteRef.current) base.current = remoteRef.current
      changeRemote(null)
      setError(null)
    },
    toggleTaskAtLine: (line: number) => transform((value) => toggleTaskLine(value, line)),
    appendTask: (text: string) =>
      transform((value) =>
        text.trim()
          ? `${value}${value && !value.endsWith('\n') ? '\n' : ''}- [ ] ${text.trim()}\n`
          : value
      ),
    appendSubtask: (line: number, text: string) =>
      transform((value) => (text.trim() ? appendChildTaskAtLine(value, line, text.trim()) : value)),
    updateTaskText: (line: number, text: string) =>
      transform((value) => (text.trim() ? updateTaskTextAtLine(value, line, text.trim()) : value)),
    deleteTask: (line: number) => transform((value) => deleteTaskLine(value, line)),
  }
}
