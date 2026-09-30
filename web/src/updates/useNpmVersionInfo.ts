import { useEffect, useState } from 'react'
import type { VersionInfoPayload } from '../../../src/server/version-service.js'
import { readLatestNpmVersion } from './npm-version-api.js'

const CHECK_INTERVAL_MS = 15 * 60 * 1_000

export const useNpmVersionInfo = (enabled: boolean): VersionInfoPayload | null => {
  const [info, setInfo] = useState<VersionInfoPayload | null>(null)

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let request: AbortController | null = null

    const check = async () => {
      if (disposed || request || document.visibilityState === 'hidden') return
      const controller = new AbortController()
      request = controller
      const timeout = setTimeout(() => controller.abort(), 10_000)
      try {
        const latest = await readLatestNpmVersion(controller.signal)
        if (!disposed) setInfo(latest)
      } catch {
        // An optional npm check must not interrupt work when the registry or runtime is offline.
        // Retain any previously confirmed update until a successful lookup replaces it.
      } finally {
        clearTimeout(timeout)
        request = null
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void check()
    }
    void check()
    const timer = setInterval(() => void check(), CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      request?.abort()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled])

  return enabled ? info : null
}
