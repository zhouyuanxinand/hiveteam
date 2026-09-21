import type { TasksSnapshot } from '../../../src/shared/tasks.js'
import { apiFetch, readErrorMessage } from '../api.js'

export class TasksConflictError extends Error {
  constructor(
    readonly current: TasksSnapshot,
    message: string
  ) {
    super(message)
  }
}
export const getWorkspaceTasks = async (workspaceId: string): Promise<TasksSnapshot> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks`)
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to load tasks'))
  return response.json() as Promise<TasksSnapshot>
}
export const saveWorkspaceTasks = async (
  workspaceId: string,
  input: { content: string; expected_version: string }
): Promise<TasksSnapshot> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (response.status === 409) {
    const payload = (await response.json()) as { current: TasksSnapshot; error: string }
    throw new TasksConflictError(payload.current, payload.error)
  }
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to save tasks'))
  return response.json() as Promise<TasksSnapshot>
}
