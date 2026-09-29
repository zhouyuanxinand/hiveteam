import type { MemorySourceSnapshot } from '../../../src/shared/memory-provenance.js'
import { apiFetch, readErrorMessage } from '../api.js'

export const loadMemorySources = async (
  workspaceId: string,
  memoryId: string,
  signal: AbortSignal
) => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/memory/${encodeURIComponent(memoryId)}/sources`,
    { signal }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to load memory sources'))
  return (await response.json()) as { memory_id: string; sources: MemorySourceSnapshot[] }
}
