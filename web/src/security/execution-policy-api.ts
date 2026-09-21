import type {
  ExecutionPolicyUpdate,
  ExecutionPolicyView,
} from '../../../src/shared/execution-policy.js'
import { apiFetch, readErrorMessage } from '../api.js'

export const executionPolicyRequest = async (
  workspaceId: string,
  agentId: string,
  method: 'GET' | 'PUT' | 'DELETE' = 'GET',
  body?: ExecutionPolicyUpdate
): Promise<ExecutionPolicyView> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/execution-policy`,
    {
      method,
      cache: 'no-store',
      ...(body
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Unable to load execution policy'))
  return (await response.json()) as ExecutionPolicyView
}
