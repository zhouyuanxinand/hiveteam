import '@xterm/xterm/css/xterm.css'
import '../../web/src/styles/globals.css'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../web/src/i18n.js'
import { TerminalView } from '../../web/src/terminal/TerminalView.js'
import { applyUiTheme } from '../../web/src/theme.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'

export const mount = (workspaceId: string, agentId: string, runId: string) => {
  localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'zh')
  applyUiTheme('dark')
  document.body.style.margin = '0'
  const slot = document.createElement('div')
  slot.id = `worker-pty-${runId}`
  slot.style.height = '100vh'
  document.body.append(slot)
  const root = document.createElement('div')
  document.body.append(root)
  createRoot(root).render(
    <I18nProvider>
      <TerminalView owner={{ workspaceId, agentId }} runId={runId} title="终端验收" />
    </I18nProvider>
  )
}
