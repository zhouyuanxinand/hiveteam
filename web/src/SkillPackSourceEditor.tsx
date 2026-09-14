import { ChevronRight, LoaderCircle } from 'lucide-react'
import { useEffect, useRef } from 'react'

import type { SkillPackSource } from '../../src/shared/skill-packs.js'
import { useI18n } from './i18n.js'
import type {
  SkillPackEditorAction,
  SkillPackEditorBusy,
  SkillPackSourceDraft,
} from './skill-pack-editor-model.js'

interface SkillPackSourceEditorProps {
  action: SkillPackEditorAction
  busy: SkillPackEditorBusy
  draft: SkillPackSourceDraft
  onChange: (draft: SkillPackSourceDraft) => void
  onResolve: () => void
}

export const SkillPackSourceEditor = ({
  action,
  busy,
  draft,
  onChange,
  onResolve,
}: SkillPackSourceEditorProps) => {
  const { t } = useI18n()
  const packNameInputRef = useRef<HTMLInputElement>(null)
  const disabled = action === 'update' || busy !== null
  const update = (change: Partial<SkillPackSourceDraft>) => onChange({ ...draft, ...change })

  useEffect(() => {
    if (action === 'bind') packNameInputRef.current?.focus()
  }, [action])

  return (
    <div className="skill-source-form">
      <label>
        <span>{t('skills.packName')}</span>
        <input
          ref={packNameInputRef}
          value={draft.packName}
          disabled={disabled}
          onChange={(event) => update({ packName: event.target.value })}
        />
      </label>
      <label>
        <span>{t('skills.sourceType')}</span>
        <select
          value={draft.sourceType}
          disabled={disabled}
          onChange={(event) =>
            update({ sourceType: event.target.value as SkillPackSource['type'] })
          }
        >
          <option value="github">GitHub</option>
          <option value="git">HTTPS Git</option>
          <option value="local">{t('skills.localFolder')}</option>
        </select>
      </label>
      <label className="skill-source-form__wide">
        <span>{draft.sourceType === 'github' ? t('skills.repository') : t('skills.source')}</span>
        <input
          value={draft.sourceValue}
          disabled={disabled}
          onChange={(event) => update({ sourceValue: event.target.value })}
        />
      </label>
      {draft.sourceType !== 'local' ? (
        <label>
          <span>{t('skills.ref')}</span>
          <input
            value={draft.sourceRef}
            disabled={disabled}
            onChange={(event) => update({ sourceRef: event.target.value })}
          />
        </label>
      ) : null}
      <button
        type="button"
        className="skill-action-button skill-action-button--primary"
        disabled={busy !== null || !draft.packName.trim() || !draft.sourceValue.trim()}
        onClick={onResolve}
      >
        {busy === 'resolve' ? (
          <LoaderCircle className="animate-spin" size={14} />
        ) : (
          <ChevronRight size={14} />
        )}
        {t('skills.resolve')}
      </button>
    </div>
  )
}
