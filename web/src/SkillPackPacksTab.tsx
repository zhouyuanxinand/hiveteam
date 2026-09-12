import { AlertTriangle, PackagePlus, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import type {
  SkillChangePlan,
  SkillPackRelease,
  SkillPackSource,
  SkillProfileName,
  WorkspaceSkillInspection,
} from '../../src/shared/skill-packs.js'
import { skillProfileNames } from '../../src/shared/skill-packs.js'
import { useI18n } from './i18n.js'
import { SkillChangePlanPreview } from './SkillChangePlanPreview.js'
import { SkillPackBoundList } from './SkillPackBoundList.js'
import { SkillPackReleasePreview } from './SkillPackReleasePreview.js'
import { SkillPackSourceEditor } from './SkillPackSourceEditor.js'
import {
  applyWorkspaceSkillChangePlan,
  createWorkspaceSkillChangePlan,
  resolveWorkspaceSkillPack,
} from './skill-pack-api.js'
import {
  createDefaultSkillPackSourceDraft,
  createEmptySkillPackSelection,
  describeSkillPackSourceDraft,
  type SkillPackEditorAction,
  type SkillPackEditorBusy,
  selectSkillsForRelease,
  skillPackSourceFromDraft,
} from './skill-pack-editor-model.js'

interface SkillPackPacksTabProps {
  inspection: WorkspaceSkillInspection
  onChanged: () => Promise<void>
  workspaceId: string
}

export const SkillPackPacksTab = ({
  inspection,
  onChanged,
  workspaceId,
}: SkillPackPacksTabProps) => {
  const { t } = useI18n()
  const [editorOpen, setEditorOpen] = useState(inspection.configuration.packs.length === 0)
  const [action, setAction] = useState<SkillPackEditorAction>('bind')
  const [draft, setDraft] = useState(createDefaultSkillPackSourceDraft)
  const [release, setRelease] = useState<SkillPackRelease | null>(null)
  const [plan, setPlan] = useState<SkillChangePlan | null>(null)
  const [selection, setSelection] = useState(createEmptySkillPackSelection)
  const [busy, setBusy] = useState<SkillPackEditorBusy>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const resolvePack = async (override?: {
    action: SkillPackEditorAction
    name: string
    source: SkillPackSource
  }) => {
    setBusy('resolve')
    setError(null)
    setNotice(null)
    setPlan(null)
    try {
      const nextAction = override?.action ?? action
      const name = override?.name ?? draft.packName
      const source = override?.source ?? skillPackSourceFromDraft(draft)
      const nextRelease = await resolveWorkspaceSkillPack(workspaceId, { name, source })
      setAction(nextAction)
      setDraft(describeSkillPackSourceDraft(name, source, draft.sourceRef))
      setRelease(nextRelease)
      setSelection(selectSkillsForRelease(nextRelease, nextAction, inspection.configuration))
      const currentLock = inspection.lock.packs.find((pack) => pack.name === name)
      if (currentLock?.contentDigest === nextRelease.contentDigest) {
        setNotice(t('skills.alreadyCurrent'))
      }
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : String(resolveError))
    } finally {
      setBusy(null)
    }
  }

  const reviewPlan = async () => {
    if (!release) return
    setBusy('plan')
    setError(null)
    try {
      const nextPlan = await createWorkspaceSkillChangePlan(workspaceId, {
        action,
        nativeExposure: [...selection.nativeExposure],
        packName: release.packName,
        profiles: Object.fromEntries(
          skillProfileNames.map((profile) => [profile, [...selection.profiles[profile]]])
        ),
        releaseId: release.id,
      })
      setPlan(nextPlan)
    } catch (planError) {
      setError(planError instanceof Error ? planError.message : String(planError))
    } finally {
      setBusy(null)
    }
  }

  const applyPlan = async () => {
    if (!plan) return
    setBusy('apply')
    setError(null)
    try {
      await applyWorkspaceSkillChangePlan(workspaceId, plan.id)
      setPlan(null)
      setRelease(null)
      setEditorOpen(false)
      await onChanged()
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError))
    } finally {
      setBusy(null)
    }
  }

  const planRemoval = async (name: string) => {
    setBusy('remove')
    setError(null)
    setNotice(null)
    setEditorOpen(true)
    setRelease(null)
    try {
      setPlan(
        await createWorkspaceSkillChangePlan(workspaceId, {
          action: 'remove',
          packName: name,
        })
      )
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError))
    } finally {
      setBusy(null)
    }
  }

  const beginUpdate = (name: string) => {
    const binding = inspection.configuration.packs.find((pack) => pack.name === name)
    if (!binding) return
    setEditorOpen(true)
    void resolvePack({ action: 'update', name, source: binding.source })
  }

  const toggleProfile = (profile: SkillProfileName, skillName: string) => {
    setSelection((current) => {
      const selected = new Set(current.profiles[profile])
      if (selected.has(skillName)) selected.delete(skillName)
      else selected.add(skillName)
      return { ...current, profiles: { ...current.profiles, [profile]: selected } }
    })
    setPlan(null)
  }

  const toggleNative = (skillName: string) => {
    setSelection((current) => {
      const nativeExposure = new Set(current.nativeExposure)
      if (nativeExposure.has(skillName)) nativeExposure.delete(skillName)
      else nativeExposure.add(skillName)
      return { ...current, nativeExposure }
    })
    setPlan(null)
  }

  return (
    <div className="skill-pack-pane">
      <div className="skill-pack-pane__heading">
        <div>
          <strong>{t('skills.boundPacks')}</strong>
          <p>{t('skills.boundPacksHint')}</p>
        </div>
        <button
          type="button"
          className="skill-action-button skill-action-button--primary"
          onClick={() => {
            setAction('bind')
            setEditorOpen(true)
            setRelease(null)
            setPlan(null)
            setNotice(null)
          }}
        >
          <PackagePlus size={14} aria-hidden />
          {t('skills.addPack')}
        </button>
      </div>

      <SkillPackBoundList
        busy={busy !== null}
        inspection={inspection}
        onRemove={(name) => void planRemoval(name)}
        onUpdate={beginUpdate}
      />

      {editorOpen ? (
        <section className="skill-pack-editor" aria-label={t('skills.packEditor')}>
          <header>
            <div>
              <strong>{action === 'bind' ? t('skills.addPack') : t('skills.updatePack')}</strong>
              <p>{t('skills.resolveHint')}</p>
            </div>
            <button
              type="button"
              className="skill-editor-close"
              onClick={() => {
                setEditorOpen(false)
                setRelease(null)
                setPlan(null)
              }}
            >
              {t('common.close')}
            </button>
          </header>

          {!plan ? (
            <SkillPackSourceEditor
              action={action}
              busy={busy}
              draft={draft}
              onChange={setDraft}
              onResolve={() => void resolvePack()}
            />
          ) : null}

          {error ? (
            <div className="skill-inline-alert" role="alert">
              <AlertTriangle size={14} /> {error}
            </div>
          ) : null}
          {notice ? (
            <div className="skill-inline-notice">
              <ShieldCheck size={14} /> {notice}
            </div>
          ) : null}

          {release && !plan ? (
            <SkillPackReleasePreview
              busy={busy}
              currentLock={inspection.lock.packs.find((pack) => pack.name === release.packName)}
              onReviewPlan={() => void reviewPlan()}
              onToggleNative={toggleNative}
              onToggleProfile={toggleProfile}
              release={release}
              selection={selection}
            />
          ) : null}

          {plan ? (
            <SkillChangePlanPreview busy={busy} onApply={() => void applyPlan()} plan={plan} />
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
