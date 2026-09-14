import { FolderInput, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FsProbeResponse } from '../api.js'
import { useI18n } from '../i18n.js'
import { type DesktopFolderProbeErrorCode, getDesktopBridge } from './desktop-bridge.js'

type DesktopFolderDropTargetProps = {
  onError: (message: string) => void
  onFolder: (probe: FsProbeResponse) => void
}

const includesFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files')

export const DesktopFolderDropTarget = ({ onError, onFolder }: DesktopFolderDropTargetProps) => {
  const { t } = useI18n()
  const [active, setActive] = useState(false)
  const [resolving, setResolving] = useState(false)
  const dragDepthRef = useRef(0)
  const requestSequenceRef = useRef(0)

  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge) return

    const reset = () => {
      dragDepthRef.current = 0
      setActive(false)
    }
    const handleDragEnter = (event: DragEvent) => {
      if (!includesFiles(event)) return
      event.preventDefault()
      if (dragDepthRef.current === 0) {
        requestSequenceRef.current += 1
        setResolving(false)
      }
      dragDepthRef.current += 1
      setActive(true)
    }
    const handleDragOver = (event: DragEvent) => {
      if (!includesFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const handleDragLeave = (_event: DragEvent) => {
      if (dragDepthRef.current === 0) return
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setActive(false)
    }
    const showProbeError = (errorCode: DesktopFolderProbeErrorCode) => {
      const messages: Record<DesktopFolderProbeErrorCode, string> = {
        not_directory: t('workspace.drop.error.notDirectory'),
        path_unavailable: t('workspace.drop.error.pathUnavailable'),
        runtime_unavailable: t('workspace.drop.error.runtimeUnavailable'),
      }
      onError(messages[errorCode])
    }
    const handleDrop = (event: DragEvent) => {
      if (!includesFiles(event)) return
      event.preventDefault()
      reset()
      const requestSequence = ++requestSequenceRef.current

      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length !== 1) {
        setResolving(false)
        onError(t('workspace.drop.error.singleFolder'))
        return
      }

      const [file] = files
      if (!file) return
      setResolving(true)
      void bridge
        .probeDroppedFolder(file)
        .then((result) => {
          if (requestSequence !== requestSequenceRef.current) return
          if (!result.ok) {
            showProbeError(result.error_code)
            return
          }
          onFolder(result.probe)
        })
        .catch(() => {
          if (requestSequence === requestSequenceRef.current) {
            onError(t('workspace.drop.error.runtimeUnavailable'))
          }
        })
        .finally(() => {
          if (requestSequence === requestSequenceRef.current) setResolving(false)
        })
    }

    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('drop', handleDrop)
    window.addEventListener('blur', reset)
    return () => {
      requestSequenceRef.current += 1
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('drop', handleDrop)
      window.removeEventListener('blur', reset)
    }
  }, [onError, onFolder, t])

  if (!getDesktopBridge() || (!active && !resolving)) return null

  return (
    <div
      data-testid="desktop-folder-drop-overlay"
      data-state={resolving ? 'resolving' : 'ready'}
      className="pointer-events-none fixed inset-0 z-[100] grid place-items-center p-6"
      style={{ background: 'var(--bg-overlay)' }}
    >
      <div
        role="status"
        aria-live="polite"
        className="elev-2 flex max-w-md flex-col items-center rounded-xl border border-dashed px-10 py-8 text-center"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--accent)' }}
      >
        {resolving ? (
          <LoaderCircle
            aria-hidden
            className="animate-spin"
            size={30}
            style={{ color: 'var(--accent)' }}
          />
        ) : (
          <FolderInput aria-hidden size={30} style={{ color: 'var(--accent)' }} />
        )}
        <p className="mt-4 text-base font-semibold text-pri">
          {resolving ? t('workspace.drop.resolving') : t('workspace.drop.title')}
        </p>
        {!resolving ? (
          <p className="mt-1.5 text-sm text-ter">{t('workspace.drop.description')}</p>
        ) : null}
      </div>
    </div>
  )
}
