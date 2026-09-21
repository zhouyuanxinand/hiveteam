import { useEffect } from 'react'
import type { WorkspaceSummary } from '../../../src/shared/types.js'
import { getActiveWorkspaceId, listWorkspaces } from '../api.js'
import { isRemoteMode } from './remote-permissions-api.js'

/** Replace remote scopes instead of merging them, so revocation removes stale panes. */
export const useRemoteWorkspaceSync = (
  setWorkspaces: (workspaces: WorkspaceSummary[]) => void,
  setActiveWorkspaceId: (workspaceId: string | null) => void
) => {
  useEffect(() => {
    if (!isRemoteMode()) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const [workspaces, activeId] = await Promise.all([listWorkspaces(), getActiveWorkspaceId()])
        if (cancelled) return
        setWorkspaces(workspaces)
        setActiveWorkspaceId(
          workspaces.some((workspace) => workspace.id === activeId)
            ? activeId
            : (workspaces[0]?.id ?? null)
        )
      } catch {
        // Access cannot be confirmed. Do not retain previously visible remote panes.
        if (!cancelled) {
          setWorkspaces([])
          setActiveWorkspaceId(null)
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 3000)
      }
    }
    timer = setTimeout(() => void refresh(), 3000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [setWorkspaces, setActiveWorkspaceId])
}
