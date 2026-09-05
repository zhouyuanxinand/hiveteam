import { useEffect, useState } from 'react'

import type { TeamListItem } from '../../src/shared/types.js'
import { listWorkersForWorkspaces } from './api.js'

const REFRESH_INTERVAL_MS = 500
const MAX_REFRESH_INTERVAL_MS = 5000

const getRefreshDelay = (failureCount: number) =>
  Math.min(REFRESH_INTERVAL_MS * 2 ** failureCount, MAX_REFRESH_INTERVAL_MS)

const areWorkersEqual = (a: TeamListItem[], b: TeamListItem[]): boolean => {
  if (a.length !== b.length) return false
  return a.every((worker, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      worker.avatar === other.avatar &&
      worker.id === other.id &&
      worker.lastPtyLine === other.lastPtyLine &&
      worker.name === other.name &&
      worker.pendingTaskCount === other.pendingTaskCount &&
      worker.role === other.role &&
      worker.status === other.status
    )
  })
}

const areWorkerMapsEqual = (
  a: Record<string, TeamListItem[]>,
  b: Record<string, TeamListItem[]>
): boolean => {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return bKeys.every((workspaceId) => areWorkersEqual(a[workspaceId] ?? [], b[workspaceId] ?? []))
}

export const useWorkspaceWorkers = (workspaceIds: readonly string[]) => {
  const workspaceKey = workspaceIds.join('\0')
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useState<Record<string, TeamListItem[]>>(
    {}
  )

  useEffect(() => {
    if (!workspaceKey) {
      setWorkersByWorkspaceId({})
      return
    }
    let cancelled = false
    let inFlight = false
    let failureCount = 0
    let timeout: number | undefined
    const ids = workspaceKey.split('\0')
    const scheduleNextLoad = () => {
      if (!cancelled) timeout = window.setTimeout(loadWorkers, getRefreshDelay(failureCount))
    }
    const loadWorkers = () => {
      if (inFlight) return
      inFlight = true
      // One bulk request keeps N workspaces from multiplying the poll into N
      // requests per refresh tick.
      void listWorkersForWorkspaces(ids)
        .then((byWorkspaceId) => {
          if (cancelled) return
          failureCount = 0
          setWorkersByWorkspaceId((current) => {
            const next: Record<string, TeamListItem[]> = {}
            for (const workspaceId of ids) {
              next[workspaceId] = byWorkspaceId[workspaceId] ?? current[workspaceId] ?? []
            }
            return areWorkerMapsEqual(current, next) ? current : next
          })
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            failureCount = Math.min(failureCount + 1, 4)
            console.error('[hive] swallowed:workspaceWorkers.list', error)
          }
        })
        .finally(() => {
          inFlight = false
          scheduleNextLoad()
        })
    }
    loadWorkers()
    return () => {
      cancelled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [workspaceKey])

  return [workersByWorkspaceId, setWorkersByWorkspaceId] as const
}
