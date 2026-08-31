import { ImagePlus, Pencil, Play, Square, Trash2 } from 'lucide-react'
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import { CliAgentAvatar } from './CliAgentAvatar.js'
import { presentWorkerStatus, type WorkerStatusKind } from './worker-status.js'

const pillToneByStatus: Record<WorkerStatusKind, string> = {
  working: 'pill--green',
  idle: 'pill--ghost',
  stopped: 'pill--red',
}
const roleKey = (role: TeamListItem['role']) =>
  `role.${role}` as 'role.coder' | 'role.custom' | 'role.reviewer' | 'role.tester'
const statusKey = (status: WorkerStatusKind) => {
  if (status === 'working') return 'common.running'
  if (status === 'idle') return 'common.idle'
  return 'common.stopped'
}

export type WorkerCardActionKind = 'start' | 'stop' | 'avatar' | 'rename' | 'delete'

type WorkerCardProps = {
  canEditAvatar?: boolean
  hasRun: boolean
  isEditing?: boolean
  isPending?: boolean
  onAction?: (kind: WorkerCardActionKind, worker: TeamListItem) => void
  onCancelRename?: () => void
  onClick: (worker: TeamListItem) => void
  onRename?: (worker: TeamListItem, name: string) => Promise<{ error: string | null }>
  renameBusy?: boolean
  worker: TeamListItem
}

export const WorkerCard = ({
  canEditAvatar = false,
  hasRun,
  isEditing = false,
  isPending = false,
  onAction,
  onCancelRename,
  onClick,
  onRename,
  renameBusy = false,
  worker,
}: WorkerCardProps) => {
  const { t } = useI18n()
  const status = presentWorkerStatus(worker)
  const [draftName, setDraftName] = useState(worker.name)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const committingRef = useRef(false)

  useEffect(() => {
    if (!isEditing) return
    setDraftName(worker.name)
    const timeout = window.setTimeout(() => inputRef.current?.select(), 0)
    return () => window.clearTimeout(timeout)
  }, [isEditing, worker.name])

  const commitRename = async () => {
    if (committingRef.current || renameBusy) return
    const nextName = draftName.trim()
    if (!nextName || nextName === worker.name) {
      onCancelRename?.()
      return
    }
    committingRef.current = true
    try {
      const result = await onRename?.(worker, nextName)
      if (result?.error) {
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    } finally {
      committingRef.current = false
    }
  }

  const handleAction =
    (kind: WorkerCardActionKind): ((event: ReactMouseEvent<HTMLButtonElement>) => void) =>
    (event) => {
      event.stopPropagation()
      onAction?.(kind, worker)
    }

  return (
    <div
      className="worker-card-shell relative"
      data-status={status.kind}
      data-worker-name={worker.name}
    >
      <div
        className="card card--interactive worker-card relative w-full overflow-hidden p-3 text-left"
        data-testid={`worker-card-${worker.id}`}
        data-status={status.kind}
      >
        <button
          type="button"
          className="worker-card__open-target"
          onClick={() => onClick(worker)}
          aria-label={t('worker.open', { name: worker.name })}
          disabled={isEditing}
        />
        <div className="worker-card__content">
          <div className="worker-card__identity-row">
            <CliAgentAvatar
              avatar={worker.avatar}
              commandPresetId={worker.commandPresetId}
              workerRole={worker.role}
              size={40}
              statusRing={status.kind}
            />
            <div className="worker-card__identity">
              {isEditing ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={draftName}
                  maxLength={64}
                  disabled={renameBusy}
                  className="worker-card__name-input"
                  data-testid={`worker-card-rename-input-${worker.id}`}
                  aria-label={t('worker.renameAria', { name: worker.name })}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setDraftName(event.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void commitRename()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setDraftName(worker.name)
                      onCancelRename?.()
                    }
                  }}
                />
              ) : (
                <span className="worker-card__name" title={worker.name}>
                  {worker.name}
                </span>
              )}
              <span className="worker-card__role-tag">{t(roleKey(worker.role))}</span>
            </div>
          </div>

          {worker.lastPtyLine ? (
            <p className="worker-card__activity" title={worker.lastPtyLine}>
              {worker.lastPtyLine}
            </p>
          ) : null}

          <div className="worker-card__footer">
            <span
              className={`pill ${pillToneByStatus[status.kind]} worker-card__status`}
              role="status"
              title={t(statusKey(status.kind))}
            >
              <span className={status.dotClass} aria-hidden />
              {t(statusKey(status.kind))}
            </span>
          </div>
        </div>
      </div>

      {onAction && !isEditing ? (
        <div className="worker-card__actions">
          {hasRun ? (
            <CardActionBtn
              title={t('common.stop')}
              onClick={handleAction('stop')}
              disabled={isPending}
              variant="danger"
              testId={`worker-card-stop-${worker.id}`}
              ariaLabel={t('worker.stopAria', { name: worker.name })}
            >
              <Square size={11} fill="currentColor" aria-hidden />
            </CardActionBtn>
          ) : (
            <CardActionBtn
              title={t('common.start')}
              onClick={handleAction('start')}
              disabled={isPending}
              variant="primary"
              testId={`worker-card-start-${worker.id}`}
              ariaLabel={t('worker.startAria', { name: worker.name })}
            >
              <Play size={12} aria-hidden />
            </CardActionBtn>
          )}
          {canEditAvatar ? (
            <CardActionBtn
              title={t('worker.editAvatar')}
              onClick={handleAction('avatar')}
              disabled={isPending}
              testId={`worker-card-avatar-${worker.id}`}
              ariaLabel={t('worker.editAvatarAria', { name: worker.name })}
            >
              <ImagePlus size={12} aria-hidden />
            </CardActionBtn>
          ) : null}
          <CardActionBtn
            title={t('worker.rename')}
            onClick={handleAction('rename')}
            disabled={isPending}
            testId={`worker-card-rename-${worker.id}`}
            ariaLabel={t('worker.renameAria', { name: worker.name })}
          >
            <Pencil size={12} aria-hidden />
          </CardActionBtn>
          <CardActionBtn
            title={t('common.delete')}
            onClick={handleAction('delete')}
            variant="danger"
            testId={`worker-card-delete-${worker.id}`}
            ariaLabel={t('worker.deleteAria', { name: worker.name })}
          >
            <Trash2 size={12} aria-hidden />
          </CardActionBtn>
        </div>
      ) : null}
    </div>
  )
}

interface CardActionBtnProps {
  ariaLabel: string
  children: ReactNode
  disabled?: boolean
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
  testId: string
  title: string
  variant?: 'default' | 'primary' | 'danger'
}

const CardActionBtn = ({
  ariaLabel,
  children,
  disabled,
  onClick,
  testId,
  title,
  variant = 'default',
}: CardActionBtnProps) => (
  <Tooltip label={title}>
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      data-variant={variant}
      className="worker-card__action"
    >
      {children}
    </button>
  </Tooltip>
)
