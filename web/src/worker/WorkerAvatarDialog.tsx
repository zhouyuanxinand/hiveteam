import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { WorkerAvatarField } from './WorkerAvatarField.js'

type WorkerAvatarDialogProps = {
  onClose: () => void
  onSave: (avatar: string | null) => Promise<void>
  worker: TeamListItem
}

export const WorkerAvatarDialog = ({ onClose, onSave, worker }: WorkerAvatarDialogProps) => {
  const { t } = useI18n()
  const [avatar, setAvatar] = useState<string | null>(worker.avatar ?? null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setAvatar(worker.avatar ?? null)
    setError(null)
  }, [worker.avatar])

  const save = () => {
    setSaving(true)
    setError(null)
    void onSave(avatar)
      .then(onClose)
      .catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : String(nextError))
      })
      .finally(() => setSaving(false))
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            aria-label={t('worker.editAvatarAria', { name: worker.name })}
            className="dialog-scale-pop elev-2 pointer-events-auto flex w-[520px] max-w-full flex-col overflow-hidden rounded-lg border"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          >
            <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
              <Dialog.Title className="text-lg font-semibold text-pri">
                {t('worker.editAvatar')}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-sm text-ter">
                {t('worker.editAvatarDescription', { name: worker.name })}
              </Dialog.Description>
            </div>
            <div className="max-h-[min(620px,calc(100vh-210px))] overflow-y-auto px-5 py-4">
              <WorkerAvatarField
                avatar={avatar}
                disabled={saving}
                onChange={setAvatar}
                workerRole={worker.role}
              />
              {error ? <p className="mt-3 text-sm text-[var(--status-red)]">{error}</p> : null}
            </div>
            <div
              className="flex items-center justify-end gap-2 border-t px-5 py-3"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
            >
              <button type="button" onClick={onClose} disabled={saving} className="icon-btn">
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="icon-btn icon-btn--primary"
                data-testid="worker-avatar-save"
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
