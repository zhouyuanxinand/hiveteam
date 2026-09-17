// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { ConversationTurn } from '../../src/shared/agent-conversation.js'
import { ConversationTurns } from '../../web/src/terminal/ConversationTurns.js'

afterEach(cleanup)
test('collapses the process on a final answer, preserves the answer and allows reopening', async () => {
  const turn: ConversationTurn = {
    id: 't',
    prompt: '需求',
    process: [{ id: 'p', kind: 'commentary', text: '检查文档' }],
    status: 'running',
    answer: '',
  }
  const view = render(<ConversationTurns turns={[turn]} />)
  expect(view.container.querySelector('details')?.open).toBe(true)
  view.rerender(<ConversationTurns turns={[{ ...turn, status: 'complete', answer: '最终结论' }]} />)
  await waitFor(() => expect(view.container.querySelector('details')?.open).toBe(false))
  expect(screen.getByText('最终结论')).toBeVisible()
  expect(screen.queryByText('检查文档')).toBeNull()
  fireEvent.click(view.container.querySelector('summary') as HTMLElement)
  await waitFor(() => expect(screen.getByText('检查文档')).toBeVisible())
  view.rerender(<ConversationTurns turns={[{ ...turn, status: 'complete', answer: '最终结论' }]} />)
  expect(view.container.querySelector('details')?.open).toBe(true)
})
