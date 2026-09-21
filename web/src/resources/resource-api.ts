import type { ResourceLimits } from '../../../src/shared/resource-budget.js'
import type { ResourceStatus } from '../../../src/shared/resource-status.js'
import { apiFetch, readErrorMessage } from '../api.js'

export const readResourceStatus = async (): Promise<ResourceStatus> => {
  const response = await apiFetch('/api/resources', { cache: 'no-store' })
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Unable to read resources'))
  return (await response.json()) as ResourceStatus
}

export const updateResourceLimits = async (limits: ResourceLimits) => {
  const response = await apiFetch('/api/resources', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(limits),
  })
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Unable to save limits'))
}

export const changeResourceExecution = async (path: string) => {
  const response = await apiFetch(path, { method: 'POST' })
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Unable to update execution'))
}
