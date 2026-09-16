type CaptureWaiter = {
  knownSessionIds: Set<string>
  filterSessionIds?: (sessionIds: string[]) => string[]
  onCapture: (sessionId: string) => void
  reject: (error: unknown) => void
  resolve: () => void
}

const claimedByProjectKey = new Map<string, Set<string>>()
const pollersByProjectKey = new Map<string, ReturnType<typeof setInterval>>()
const waitersByProjectKey = new Map<string, CaptureWaiter[]>()

const clearPollerIfIdle = (projectKey: string) => {
  if ((waitersByProjectKey.get(projectKey)?.length ?? 0) > 0) return
  const poller = pollersByProjectKey.get(projectKey)
  if (poller) clearInterval(poller)
  pollersByProjectKey.delete(projectKey)
  claimedByProjectKey.delete(projectKey)
}

const flushWaiters = (projectKey: string, listSessionIds: () => string[]) => {
  const waiters = waitersByProjectKey.get(projectKey)
  if (!waiters?.length) return clearPollerIfIdle(projectKey)
  const claimedSessionIds = claimedByProjectKey.get(projectKey) ?? new Set<string>()
  claimedByProjectKey.set(projectKey, claimedSessionIds)
  const availableSessionIds = listSessionIds().filter(
    (sessionId) => !claimedSessionIds.has(sessionId)
  )
  const remainingWaiters: CaptureWaiter[] = []

  for (const waiter of waiters) {
    const candidateSessionIds = availableSessionIds.filter(
      (sessionId) => !waiter.knownSessionIds.has(sessionId)
    )
    const nextSessionId = candidateSessionIds.length
      ? (waiter.filterSessionIds?.(candidateSessionIds) ?? candidateSessionIds)[0]
      : undefined
    if (!nextSessionId) {
      remainingWaiters.push(waiter)
      continue
    }
    try {
      waiter.onCapture(nextSessionId)
      claimedSessionIds.add(nextSessionId)
      availableSessionIds.splice(availableSessionIds.indexOf(nextSessionId), 1)
      waiter.resolve()
    } catch (error) {
      waiter.reject(error)
    }
  }

  waitersByProjectKey.set(projectKey, remainingWaiters)
  clearPollerIfIdle(projectKey)
}

export const captureSessionIdWithCoordinator = async ({
  intervalMs = 100,
  knownSessionIds,
  listSessionIds,
  onCapture,
  projectKey,
  timeoutMs = 5000,
  filterSessionIds,
  signal,
}: {
  intervalMs?: number
  knownSessionIds: Set<string>
  listSessionIds: () => string[]
  filterSessionIds?: (sessionIds: string[]) => string[]
  onCapture: (sessionId: string) => void
  projectKey: string
  timeoutMs?: number | null
  signal?: AbortSignal | undefined
}) => {
  if (signal?.aborted) return
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
    const removeWaiter = () => {
      waitersByProjectKey.set(
        projectKey,
        (waitersByProjectKey.get(projectKey) ?? []).filter((candidate) => candidate !== waiter)
      )
      clearPollerIfIdle(projectKey)
    }
    const abort = () => {
      // Native CLIs may flush their first session file only while exiting.
      flushWaiters(projectKey, listSessionIds)
      removeWaiter()
      waiter.resolve()
    }
    const waiter: CaptureWaiter = {
      knownSessionIds,
      ...(filterSessionIds ? { filterSessionIds } : {}),
      onCapture,
      reject: (error) => {
        cleanup()
        reject(error)
      },
      resolve: () => {
        cleanup()
        resolve()
      },
    }
    if (timeoutMs !== null) {
      timeout = setTimeout(() => {
        removeWaiter()
        waiter.resolve()
      }, timeoutMs)
      timeout.unref?.()
    }
    signal?.addEventListener('abort', abort, { once: true })
    waitersByProjectKey.set(projectKey, [...(waitersByProjectKey.get(projectKey) ?? []), waiter])
    if (!pollersByProjectKey.has(projectKey)) {
      pollersByProjectKey.set(
        projectKey,
        setInterval(() => flushWaiters(projectKey, listSessionIds), intervalMs)
      )
      pollersByProjectKey.get(projectKey)?.unref?.()
    }
    flushWaiters(projectKey, listSessionIds)
  })
}

export const resetSessionCaptureCoordinatorForTests = () => {
  for (const poller of pollersByProjectKey.values()) clearInterval(poller)
  pollersByProjectKey.clear()
  waitersByProjectKey.clear()
  claimedByProjectKey.clear()
}
