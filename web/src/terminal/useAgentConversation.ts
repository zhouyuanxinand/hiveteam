import { useEffect, useState } from 'react'
import type { AgentConversation } from '../../../src/shared/agent-conversation.js'
import { apiFetch } from '../api.js'

const recent = new Map<string, AgentConversation>()

export const useAgentConversation = (
  workspaceId: string,
  agentId: string,
  runId: string,
  enabled = true
) => {
  const key = JSON.stringify([workspaceId, agentId, runId])
  const [state, setState] = useState<{
    key: string
    data: AgentConversation | undefined
    failed: boolean
  }>({ key, data: recent.get(key), failed: false })
  const [retry, setRetry] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry restarts polling for the same recipient.
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    let controller: AbortController | undefined
    setState({ key, data: recent.get(key), failed: false })
    const poll = async () => {
      if (disposed) return
      if (document.hidden) {
        timer = setTimeout(poll, 2000)
        return
      }
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 5000)
      let supported = true
      try {
        const response = await apiFetch(
          `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/conversation?run_id=${encodeURIComponent(runId)}`,
          { signal: controller.signal }
        )
        if (!response.ok) throw new Error(`Conversation HTTP ${response.status}`)
        const data = (await response.json()) as AgentConversation
        if (disposed) return
        recent.delete(key)
        recent.set(key, data)
        while (recent.size > 24) recent.delete(recent.keys().next().value as string)
        setState({ key, data, failed: false })
        supported = data.status !== 'unsupported'
      } catch {
        if (!disposed) setState((current) => ({ ...current, failed: true }))
      } finally {
        clearTimeout(timeout)
        if (!disposed && supported) timer = setTimeout(poll, 2000)
      }
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
      controller?.abort()
    }
  }, [workspaceId, agentId, key, runId, retry, enabled])
  return {
    ...(state.key === key ? state : { data: recent.get(key), failed: false }),
    retry: () => setRetry((value) => value + 1),
  }
}
