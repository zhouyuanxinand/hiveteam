import { AsyncLocalStorage } from 'node:async_hooks'

type InputExecution = (runId: string, byteCount: number, write: (() => void) | null) => void
export interface RemoteQueueGrant {
  deviceId: string
  workspaceId: string
  grantIds: string[]
}
const authorization = new AsyncLocalStorage<{
  check: () => void
  input?: InputExecution
  grant?: RemoteQueueGrant
}>()

/** Carries the request's original grant across asynchronous preparation. */
export const withRemoteActionCheck = <T>(
  check: () => void,
  action: () => T,
  input?: InputExecution,
  grant?: RemoteQueueGrant
): T =>
  authorization.run({ check, ...(input ? { input } : {}), ...(grant ? { grant } : {}) }, action)

export const captureRemoteQueueGrant = () => {
  const grant = authorization.getStore()?.grant
  return grant ? { ...grant, grantIds: [...grant.grantIds] } : null
}

export const recheckRemoteAction = () => authorization.getStore()?.check()

export const withAdditionalActionCheck = <T>(check: () => void, action: () => T): T => {
  const parent = authorization.getStore()
  return withRemoteActionCheck(
    () => {
      parent?.check()
      check()
    },
    action,
    parent?.input
      ? (runId, bytes, write) => {
          check()
          parent.input?.(runId, bytes, write)
        }
      : undefined,
    parent?.grant
  )
}

export const checkPendingRemoteInput = (runId: string, byteCount: number) => {
  const context = authorization.getStore()
  if (context?.input) context.input(runId, byteCount, null)
  else context?.check()
}

/** Delayed HTTP input retains its original grant until the actual PTY write. */
export const executeRemoteInput = (runId: string, byteCount: number, write: () => void) => {
  const context = authorization.getStore()
  if (context?.input) context.input(runId, byteCount, write)
  else {
    context?.check()
    write()
  }
}

/** Runtime-owned lifecycle work continues independently of the request that started it. */
export const withoutRemoteActionContext = <T>(action: () => T): T => authorization.exit(action)
