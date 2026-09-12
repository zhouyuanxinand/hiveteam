import { AlertTriangle, CheckCircle2, Clock3, RotateCcw, ScrollText } from 'lucide-react'
import { useState } from 'react'

import type {
  SkillChangePlan,
  SkillChangeReceipt,
  WorkspaceSkillInspection,
} from '../../src/shared/skill-packs.js'
import { type TranslationKey, useI18n } from './i18n.js'
import { applyWorkspaceSkillChangePlan, undoWorkspaceSkillChangeReceipt } from './skill-pack-api.js'

interface SkillPackChangesTabProps {
  inspection: WorkspaceSkillInspection
  onChanged: () => Promise<void>
  workspaceId: string
}

const operationLabel = (kind: SkillChangePlan['operations'][number]['kind']) =>
  `skills.operation.${kind}` as TranslationKey

const ChangeOperations = ({ operations }: { operations: SkillChangePlan['operations'] }) => {
  const { t } = useI18n()
  return (
    <div className="skill-operation-list">
      {operations.map((operation) => (
        <div key={`${operation.kind}:${operation.path}`}>
          <span>{t(operationLabel(operation.kind))}</span>
          <code title={operation.path}>{operation.path}</code>
        </div>
      ))}
    </div>
  )
}

export const SkillPackChangesTab = ({
  inspection,
  onChanged,
  workspaceId,
}: SkillPackChangesTabProps) => {
  const { t } = useI18n()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = async (plan: SkillChangePlan) => {
    setBusyId(plan.id)
    setError(null)
    try {
      await applyWorkspaceSkillChangePlan(workspaceId, plan.id)
      await onChanged()
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError))
    } finally {
      setBusyId(null)
    }
  }

  const undo = async (receipt: SkillChangeReceipt) => {
    setBusyId(receipt.id)
    setError(null)
    try {
      await undoWorkspaceSkillChangeReceipt(workspaceId, receipt.id)
      await onChanged()
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : String(undoError))
    } finally {
      setBusyId(null)
    }
  }

  if (inspection.plans.length === 0 && inspection.receipts.length === 0) {
    return (
      <div className="workspace-knowledge-state">
        <ScrollText size={28} aria-hidden />
        <strong>{t('skills.noChanges')}</strong>
        <p>{t('skills.noChangesDescription')}</p>
      </div>
    )
  }

  return (
    <div className="skill-changes-pane">
      {error ? (
        <div className="skill-inline-alert" role="alert">
          <AlertTriangle size={14} aria-hidden /> {error}
        </div>
      ) : null}

      {inspection.receipts.length > 0 ? (
        <section className="skill-change-section">
          <header>
            <strong>{t('skills.receipts')}</strong>
            <span>{inspection.receipts.length}</span>
          </header>
          <div className="skill-change-list">
            {inspection.receipts.map((receipt) => (
              <article className="skill-change-card" key={receipt.id} data-state={receipt.state}>
                <div className="skill-change-card__heading">
                  {receipt.state === 'applied' || receipt.state === 'rolled_back' ? (
                    <CheckCircle2 size={16} aria-hidden />
                  ) : (
                    <AlertTriangle size={16} aria-hidden />
                  )}
                  <div>
                    <strong>{t(`skills.receipt.${receipt.state}` as TranslationKey)}</strong>
                    <span>{new Date(receipt.startedAt).toLocaleString()}</span>
                  </div>
                  {receipt.undoAvailable ? (
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void undo(receipt)}
                    >
                      <RotateCcw size={12} aria-hidden /> {t('skills.undo')}
                    </button>
                  ) : null}
                </div>
                {receipt.error ? <p className="skill-change-card__error">{receipt.error}</p> : null}
                <ChangeOperations operations={receipt.operations} />
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {inspection.plans.length > 0 ? (
        <section className="skill-change-section">
          <header>
            <strong>{t('skills.plans')}</strong>
            <span>{inspection.plans.length}</span>
          </header>
          <div className="skill-change-list">
            {inspection.plans.map((plan) => (
              <article className="skill-change-card" key={plan.id} data-state={plan.status}>
                <div className="skill-change-card__heading">
                  <Clock3 size={16} aria-hidden />
                  <div>
                    <strong>{t(`skills.plan.${plan.status}` as TranslationKey)}</strong>
                    <span>{new Date(plan.createdAt).toLocaleString()}</span>
                  </div>
                  {plan.status === 'ready' ? (
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void apply(plan)}
                    >
                      {t('skills.apply')}
                    </button>
                  ) : null}
                </div>
                <p>
                  {t('skills.planSummary', {
                    count: plan.operations.length,
                    pack: plan.intent.packName,
                  })}
                </p>
                <ChangeOperations operations={plan.operations} />
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
