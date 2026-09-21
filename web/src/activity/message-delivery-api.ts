import type { DeliveryOverview, DispatchTimeouts } from '../../../src/shared/message-delivery.js'
import { apiFetch, readErrorMessage } from '../api.js'

export const deliveryPath = (workspaceId: string) =>
  `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/message-deliveries`
export const deliveryRequest = async <T>(
  path: string,
  method = 'GET',
  body?: unknown
): Promise<T> => {
  const response = await apiFetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Unable to update task delivery'))
  return response.json() as Promise<T>
}
export const readDeliveries = (workspaceId: string) =>
  deliveryRequest<DeliveryOverview>(deliveryPath(workspaceId))
export const readTimeouts = (workspaceId: string) =>
  deliveryRequest<DispatchTimeouts>(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/dispatch-timeouts`
  )
export const healthReason = (reason: string, zh: boolean) =>
  ({
    execution_overdue: zh ? '执行时间已超过提醒期限' : 'Execution reminder is overdue',
    no_progress: zh ? '最近未收到任务进展信号' : 'No recent task progress signal',
    cancellation_unconfirmed: zh
      ? '取消后尚未确认停止，请人工核对'
      : 'Cancellation is unconfirmed; review the original execution',
    waiting_input: zh ? '等待用户输入' : 'Waiting for user input',
    waiting_permission: zh ? '等待权限批准' : 'Waiting for permission',
    paused: zh ? '已明确暂停' : 'Explicitly paused',
  })[reason] ?? reason
