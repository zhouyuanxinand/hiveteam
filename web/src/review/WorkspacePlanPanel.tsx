import * as Dialog from '@radix-ui/react-dialog'
import { FileText, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewDocumentState } from '../../../src/shared/workspace-review.js'
import { PlanEditor } from './PlanEditor.js'
import { listReviewDocuments, readReviewDocument } from './review-api.js'
import { useReviewCopy } from './review-copy.js'
import './review.css'

export const WorkspacePlanPanel = ({
  workspaceId,
  open,
  onClose,
}: {
  workspaceId: string
  open: boolean
  onClose: () => void
}) => {
  const copy = useReviewCopy()
  const [paths, setPaths] = useState<string[]>([])
  const [path, setPath] = useState('')
  const [state, setState] = useState<ReviewDocumentState | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [listVersion, setListVersion] = useState(0)
  const request = useRef(0)
  const selectedPath = useRef('')
  const load = useCallback(
    async (nextPath: string) => {
      const sequence = ++request.current
      setLoading(true)
      setError('')
      try {
        const next = await readReviewDocument(workspaceId, nextPath)
        if (request.current === sequence) {
          setState(next)
          setPath(nextPath)
          selectedPath.current = nextPath
        }
      } catch (e) {
        if (request.current === sequence) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (request.current === sequence) setLoading(false)
      }
    },
    [workspaceId]
  )
  useEffect(() => {
    if (!open) return
    // An explicit retry also reloads an initially failed/empty document list.
    void listVersion
    let current = true
    setLoading(true)
    setError('')
    void listReviewDocuments(workspaceId)
      .then((list) => {
        if (!current) return
        setPaths(list.paths)
        setTruncated(list.truncated)
        const selected = list.paths.includes(selectedPath.current)
          ? selectedPath.current
          : (list.paths.find((item) => /(?:plan|spec|方案)\.md$/i.test(item)) ?? list.paths[0])
        if (selected) void load(selected)
        else {
          setState(null)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (current) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      })
    return () => {
      current = false
      request.current++
    }
  }, [open, workspaceId, load, listVersion])
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <Dialog.Content className="workspace-plan-panel">
          <header className="review-panel-header">
            <div>
              <Dialog.Title className="text-lg font-semibold flex items-center gap-2">
                <FileText size={20} aria-hidden />
                {copy.title}
              </Dialog.Title>
              <Dialog.Description className="text-sm text-sec mt-1">
                {copy.description}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-btn" aria-label={copy.close}>
              <X size={18} aria-hidden />
            </Dialog.Close>
          </header>
          <div className="review-document-picker">
            <label className="text-sm">
              {copy.document}
              <select
                className="review-input mt-1"
                value={path}
                disabled={loading || paths.length === 0}
                onChange={(event) => {
                  setState(null)
                  void load(event.target.value)
                }}
              >
                {paths.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
            {truncated ? <p className="text-xs text-sec">{copy.limited}</p> : null}
          </div>
          {error ? (
            <div role="alert" className="review-error mx-4">
              <p>{error}</p>
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  if (path) void load(path)
                  else setListVersion((value) => value + 1)
                }}
              >
                {copy.refresh}
              </button>
            </div>
          ) : null}
          {loading ? (
            <p role="status" className="p-4 text-sec">
              {copy.loading}
            </p>
          ) : null}
          {state ? (
            <PlanEditor
              key={`${workspaceId}:${state.document.path}`}
              workspaceId={workspaceId}
              state={state}
              onUpdate={setState}
              onReload={() => {
                void load(path)
              }}
              onNavigate={(nextPath) => {
                if (paths.includes(nextPath)) void load(nextPath)
              }}
              documentPaths={paths}
            />
          ) : !loading && !error ? (
            <p className="p-6 text-sec">{copy.empty}</p>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
