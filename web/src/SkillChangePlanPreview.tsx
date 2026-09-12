import { Check, LoaderCircle, ShieldCheck } from 'lucide-react'

import type { SkillChangePlan } from '../../src/shared/skill-packs.js'
import { type TranslationKey, useI18n } from './i18n.js'
import type { SkillPackEditorBusy } from './skill-pack-editor-model.js'

interface SkillChangePlanPreviewProps {
  busy: SkillPackEditorBusy
  onApply: () => void
  plan: SkillChangePlan
}

export const SkillChangePlanPreview = ({ busy, onApply, plan }: SkillChangePlanPreviewProps) => {
  const { t } = useI18n()
  return (
    <div className="skill-plan-preview">
      <header>
        <ShieldCheck size={18} aria-hidden />
        <div>
          <strong>{t('skills.planReady')}</strong>
          <p>
            {t('skills.planSummary', {
              count: plan.operations.length,
              pack: plan.intent.packName,
            })}
          </p>
        </div>
      </header>
      <div className="skill-operation-list">
        {plan.operations.map((operation) => (
          <div key={`${operation.kind}:${operation.path}`}>
            <span>{t(`skills.operation.${operation.kind}` as TranslationKey)}</span>
            <code title={operation.path}>{operation.path}</code>
          </div>
        ))}
      </div>
      <footer className="skill-editor-footer">
        <span>{t('skills.driftChecked')}</span>
        <button
          type="button"
          className="skill-action-button skill-action-button--primary"
          disabled={busy !== null}
          onClick={onApply}
        >
          {busy === 'apply' ? (
            <LoaderCircle className="animate-spin" size={14} />
          ) : (
            <Check size={14} />
          )}
          {plan.action === 'remove' ? t('skills.applyRemove') : t('skills.apply')}
        </button>
      </footer>
    </div>
  )
}
