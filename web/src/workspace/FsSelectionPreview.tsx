import { FileText } from 'lucide-react'

import type { FsProbeResponse } from '../api.js'
import { useI18n } from '../i18n.js'

type FsSelectionPreviewProps = {
  probe: FsProbeResponse | null
  suggestedName: string
  onSuggestedNameChange: (value: string) => void
}

export const FsSelectionPreview = ({
  probe,
  suggestedName,
  onSuggestedNameChange,
}: FsSelectionPreviewProps) => {
  const { t } = useI18n()
  const selectedProbe = probe?.ok && probe.is_dir ? probe : null
  const documents = selectedProbe?.documents ?? []
  const hasProbe = selectedProbe !== null
  return (
    <div
      className="flex flex-col gap-2 rounded border p-3 text-xs"
      style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
      data-testid="fs-selection-preview"
    >
      <div className="flex items-center justify-between">
        <span className="text-ter uppercase tracking-wider text-xs">
          {t('workspace.browse.selected')}
        </span>
        {selectedProbe?.is_git_repository ? (
          <span className="role-badge role-badge--coder" data-testid="fs-preview-git-badge">
            {t('workspace.git.short', {
              branch: selectedProbe.current_branch ?? t('workspace.git.detached'),
            })}
          </span>
        ) : hasProbe ? (
          <span className="text-ter text-xs">{t('workspace.git.noneShort')}</span>
        ) : null}
      </div>
      <span className="mono truncate text-pri" data-testid="fs-preview-path">
        {selectedProbe?.path ?? '—'}
      </span>
      {documents.length > 0 ? (
        <div
          className="flex flex-col gap-1 rounded border px-2 py-2"
          style={{
            background: 'color-mix(in oklab, var(--accent) 7%, transparent)',
            borderColor: 'color-mix(in oklab, var(--accent) 24%, var(--border))',
          }}
          data-testid="fs-preview-documents"
        >
          <span className="flex items-center gap-1.5 font-medium text-sec">
            <FileText size={13} aria-hidden />
            {t('workspace.documents.detected', { count: documents.length })}
          </span>
          <span className="text-xs text-ter">{t('workspace.documents.generationHint')}</span>
          <ul className="flex max-h-20 flex-col gap-0.5 overflow-y-auto mono text-xs text-sec">
            {documents.slice(0, 5).map((document) => (
              <li key={document.path} className="truncate" title={document.relative_path}>
                {document.relative_path}
              </li>
            ))}
          </ul>
          {documents.length > 5 ? (
            <span className="text-xs text-ter">
              {t('workspace.documents.more', { count: documents.length - 5 })}
            </span>
          ) : null}
        </div>
      ) : null}
      <label className="mt-1 flex flex-col gap-1 text-ter">
        <span className="text-xs uppercase tracking-wider">{t('workspace.field.name')}</span>
        <input
          type="text"
          value={suggestedName}
          onChange={(event) => onSuggestedNameChange(event.target.value)}
          disabled={!hasProbe}
          className="mono rounded border px-2 py-1 text-sm text-pri disabled:opacity-50"
          style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
          data-testid="fs-preview-name-input"
        />
      </label>
    </div>
  )
}
