import { useEffect } from 'react'
import { healthReason, readDeliveries } from '../activity/message-delivery-api.js'
import { useI18n } from '../i18n.js'
import { useNotifications } from './NotificationProvider.js'

export const useDispatchHealthNotifications = (workspaceId: string | undefined) => {
  const { notify } = useNotifications(),
    { language } = useI18n()
  useEffect(() => {
    if (!workspaceId) return
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined
    const seen = new Set<string>()
    const key = `hive.health-notifications.${workspaceId}`
    try {
      const stored = JSON.parse(window.localStorage.getItem(key) ?? '[]')
      if (Array.isArray(stored)) for (const id of stored) if (typeof id === 'string') seen.add(id)
    } catch (error) {
      console.warn('[hiveteam] Could not read notification history', error)
    }
    const poll = async () => {
      try {
        const data = await readDeliveries(workspaceId)
        if (disposed) return
        for (const health of data.health) {
          if (!health.reasons.length || !health.notification_id || seen.has(health.notification_id))
            continue
          seen.add(health.notification_id)
          const task = data.deliveries.find(
            (item) => item.dispatch_id === health.dispatch_id && item.kind === 'dispatch'
          )
          notify({
            kind: 'warning',
            title: language === 'zh' ? '任务需要关注' : 'Task needs attention',
            brief: health.reasons
              .map((reason) => healthReason(reason, language === 'zh'))
              .join(' · '),
            detail: `${task?.recipient_name ?? ''}: ${task?.task_text ?? health.dispatch_id}`,
          })
        }
        try {
          window.localStorage.setItem(key, JSON.stringify([...seen].slice(-500)))
        } catch (error) {
          console.warn('[hiveteam] Could not save notification history', error)
        }
      } catch (error) {
        if (!disposed) console.warn('[hiveteam] Task health notifications unavailable', error)
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 5000)
      }
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [workspaceId, notify, language])
}
