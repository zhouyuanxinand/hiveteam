import { useI18n } from '../i18n.js'
import { WorkersPane } from '../worker/WorkersPane.js'
import { DemoBanner } from './DemoBanner.js'
import type { DemoReplaySnapshot } from './demo-fixture.js'

type DemoWorkspaceViewProps = {
  onExit: () => void
  replay: DemoReplaySnapshot
}

/**
 * Renders a self-running demo replay without any server-calling hooks.
 *
 * Design decision: TerminalView is tightly coupled to WebSocket subscriptions
 * and portal-based PTY mounting. Rather than extending that surface with
 * readOnly/initialScrollback, demo scrollback is rendered as a <pre> block
 * inside each worker's scrollback slot. This keeps the demo path self-contained
 * and avoids xterm.js setup in a read-only context.
 */
export const DemoWorkspaceView = ({ onExit, replay }: DemoWorkspaceViewProps) => {
  const { t } = useI18n()
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DemoBanner onExit={onExit} />
      <div className="flex min-h-0 flex-1">
        {/* Demo orchestrator panel — shows orch scrollback as pre-recorded text */}
        <div
          className="flex min-w-[320px] shrink-0 flex-col border-r"
          style={{ width: '40%', borderColor: 'var(--border)', background: 'var(--bg-crust)' }}
          data-testid="orchestrator-pane-shell"
        >
          <div
            className="flex shrink-0 items-center justify-between border-b px-3 py-2 text-xs text-ter"
            style={{ borderColor: 'var(--border)' }}
          >
            <span>{t('demo.orchestratorLabel')}</span>
            <span
              data-testid="terminal-readonly-badge"
              className="rounded bg-2 px-1.5 py-0.5 text-xs text-ter"
            >
              {t('demo.readOnlyBadge')}
            </span>
          </div>
          <pre
            className="mono flex-1 overflow-auto p-3 text-xs text-sec"
            data-testid="demo-scrollback-demo-orch"
            style={{
              background: 'var(--bg-crust)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {replay.terminalScrollback['demo-orch']}
          </pre>
        </div>
        <WorkersPane
          onAddWorkerClick={() => {}}
          onDeleteWorker={() => {}}
          onOpenWorker={() => {}}
          onRenameWorker={() => Promise.resolve({ error: null })}
          onStartWorker={() => {}}
          startingWorkerId={null}
          terminalRuns={[]}
          workers={replay.workers}
        />
      </div>
    </div>
  )
}
