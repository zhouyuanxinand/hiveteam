import { useCallback, useEffect, useState } from 'react'
import type { RemoteAccess } from '../../../src/shared/remote-permissions.js'
import { getRemoteAccess } from './remote-permissions-api.js'

export const useRemoteAccess = (deviceId?: string) => {
  const [snapshot, setSnapshot] = useState<{ access: RemoteAccess; received: number } | null>(null)
  const [now, setNow] = useState(() => performance.now())
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    try {
      const access = await getRemoteAccess(deviceId)
      setSnapshot({ access, received: performance.now() })
      setError('')
    } catch (cause) {
      setSnapshot(null)
      setError(cause instanceof Error ? cause.message : 'Unable to load access')
    }
  }, [deviceId])
  useEffect(() => {
    void refresh()
    const poll = window.setInterval(() => void refresh(), 3000)
    const tick = window.setInterval(() => setNow(performance.now()), 1000)
    return () => {
      window.clearInterval(poll)
      window.clearInterval(tick)
    }
  }, [refresh])
  const remaining = (milliseconds: number) =>
    Math.max(0, milliseconds - Math.max(0, now - (snapshot?.received ?? now)))
  return { access: snapshot?.access ?? null, remaining, refresh, error }
}
