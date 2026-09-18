/** The native PTY is the only surface; process disclosure lives inside TerminalView. */
export const AgentTerminalSurface = ({
  runId,
  slot,
}: {
  workspaceId: string
  agentId: string
  runId: string
  slot: 'worker' | 'orch'
}) => (
  <div
    id={`${slot}-pty-${runId}`}
    className="flex h-full min-h-0 w-full min-w-0"
    data-pty-slot={slot === 'orch' ? 'orchestrator' : 'worker'}
  />
)
