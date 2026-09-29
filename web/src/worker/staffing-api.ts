import type { TeamListItemPayload } from '../../../src/shared/types.js'
import type { StaffingPolicy } from '../../../src/shared/worker-lifecycle.js'
import { apiFetch, readErrorMessage } from '../api.js'

const policyPath = (id: string) => `/api/ui/workspaces/${encodeURIComponent(id)}/staffing-policy`
const request = async <T>(path: string, policy?: StaffingPolicy): Promise<T> => {
  const response = await apiFetch(
    path,
    policy
      ? {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(policy),
        }
      : undefined
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Unable to load or save staffing settings'))
  return response.json() as Promise<T>
}
export const readStaffingPolicy = (id: string) => request<StaffingPolicy>(policyPath(id))
export const saveStaffingPolicy = (id: string, policy: StaffingPolicy) =>
  request<StaffingPolicy>(policyPath(id), policy)
export const readRetiredMembers = (id: string) =>
  request<TeamListItemPayload[]>(`/api/ui/workspaces/${encodeURIComponent(id)}/members/retired`)
