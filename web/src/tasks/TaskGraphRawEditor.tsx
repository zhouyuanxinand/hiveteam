import { AlertTriangle, RefreshCw, Save } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { useI18n } from '../i18n.js'

type TaskGraphRawEditorProps = {
  content: string
  hasConflict: boolean
  remoteContent?: string | null | undefined
  onContentChange: (value: string) => void
  onKeepLocal: () => void
  onReload: () => void
  onSave: () => Promise<void>
}

/**
 * Raw markdown editor inside TaskGraphDrawer. Labels run through i18n
 * (`tasks.raw.*`); the conflict banner and the Reload / Keep local / Save
 * tasks actions used to be hardcoded in mixed Chinese/English — moved here
 * so they switch languages together.
 */
export const TaskGraphRawEditor = ({
  content,
  hasConflict,
  remoteContent,
  onContentChange,
  onKeepLocal,
  onReload,
  onSave,
}: TaskGraphRawEditorProps) => {
  const { t, language } = useI18n()
  const [saveError, setSaveError] = useState<string | null>(null)
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaveError(null)
    void onSave().catch((error: unknown) =>
      setSaveError(error instanceof Error ? error.message : String(error))
    )
  }
  return (
    <form onSubmit={handleSubmit} className="flex h-full flex-col gap-3">
      <label className="flex min-h-0 flex-1 flex-col gap-2 text-xs text-sec">
        <span className="flex items-center justify-between gap-2">
          <span className="font-medium text-sec">{t('tasks.raw.label')}</span>
          <span className="mono text-xs text-ter">
            {t('tasks.raw.lineCount', { count: content.split(/\r?\n/).length })}
          </span>
        </span>
        <textarea
          aria-label={t('tasks.raw.label')}
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          className="mono min-h-[360px] flex-1 resize-none rounded border p-3 text-sm text-pri outline-none focus:border-[var(--accent)]"
          style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
        />
      </label>
      {hasConflict ? (
        <div
          className="flex flex-wrap items-start gap-2 rounded border p-3 text-xs"
          style={{ borderColor: 'var(--status-orange)', color: 'var(--status-orange)' }}
        >
          <AlertTriangle className="mt-0.5 shrink-0" size={16} />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t('tasks.raw.conflictTitle')}</p>
            <p className="mt-1 text-ter">{t('tasks.raw.conflictDescription')}</p>
            {remoteContent !== undefined && remoteContent !== null ? (
              <details>
                <summary>
                  {language === 'zh' ? '查看磁盘上的当前内容' : 'Compare the current file'}
                </summary>
                <pre className="whitespace-pre-wrap break-words">{remoteContent}</pre>
              </details>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={onReload} className="icon-btn">
              <RefreshCw size={14} />
              {t('tasks.raw.reload')}
            </button>
            <button type="button" onClick={onKeepLocal} className="icon-btn">
              {t('tasks.raw.keepLocal')}
            </button>
          </div>
        </div>
      ) : null}
      {saveError ? (
        <p role="alert" className="dispatch-report-error">
          {saveError}
        </p>
      ) : null}
      <div className="flex justify-end border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <button type="submit" disabled={hasConflict} className="icon-btn icon-btn--primary">
          <Save size={14} />
          {t('tasks.raw.save')}
        </button>
      </div>
    </form>
  )
}
