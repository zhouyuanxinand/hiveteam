// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { AgentTerminalSurface } from '../../web/src/terminal/AgentTerminalSurface.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
test('retains one visible native terminal after an answer, without a conversation switcher', async () => {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      Response.json({
        status: 'ready',
        session_id: 'session',
        truncated: false,
        turns: [
          {
            id: 'turn',
            prompt: 'Question',
            process: [{ id: 'p', kind: 'tool', text: 'exec_command' }],
            answer: 'Final answer',
            status: 'complete',
          },
        ],
      })
    )
  )
  const view = render(
    <AgentTerminalSurface
      workspaceId="workspace"
      agentId="member"
      runId="native-only"
      slot="worker"
    />
  )
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Conversation' })).toBeNull())
  expect(screen.queryByRole('button', { name: 'Terminal / input' })).toBeNull()
  expect(document.getElementById('worker-pty-native-only')).toBeVisible()
  expect(view.container.querySelectorAll('[data-pty-slot]')).toHaveLength(1)
})
