import { useEffect, useState } from 'react'
import type { MemorySourceSnapshot } from '../../../src/shared/memory-provenance.js'
import { useI18n } from '../i18n.js'
import { loadMemorySources } from './memory-provenance-api.js'
import './memory-provenance.css'

export const MemorySourceList = ({ sources }: { sources: MemorySourceSnapshot[] }) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const stateLabels = zh
    ? {
        current: '与来源一致',
        stale: '来源已变化',
        unknown: '来源版本未知',
        restricted: '来源属于其他工作区',
      }
    : {
        current: 'Source unchanged',
        stale: 'Source changed',
        unknown: 'Source version unknown',
        restricted: 'Source belongs to another workspace',
      }
  return (
    <ul className="memory-source-list">
      {sources.map((source) => (
        <li key={source.id}>
          <strong>{stateLabels[source.state]}</strong>
          {source.state !== 'restricted' ? (
            <>
              <p>
                {source.type}
                {source.source_id ? (
                  <>
                    {' '}
                    · <code>{source.source_id}</code>
                  </>
                ) : null}
                {source.source_sequence ? <> · #{source.source_sequence}</> : null}
              </p>
              {source.actor_agent_id_snapshot ? (
                <p>
                  {zh ? '记录时的作者' : 'Author at capture'}:{' '}
                  {source.actor_name_snapshot ?? source.actor_agent_id_snapshot}
                  {source.actor_role_snapshot ? ` (${source.actor_role_snapshot})` : ''}
                </p>
              ) : null}
              {source.excerpt ? <blockquote>{source.excerpt}</blockquote> : null}
              {source.captured_version ? (
                <details>
                  <summary>{zh ? '记录时的版本哈希' : 'Captured version hash'}</summary>
                  <code>{source.captured_version}</code>
                </details>
              ) : null}
            </>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export const MemorySources = ({
  workspaceId,
  memoryId,
}: {
  workspaceId: string
  memoryId: string
}) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const [open, setOpen] = useState(false)
  const [sources, setSources] = useState<MemorySourceSnapshot[] | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!open) return
    void refresh
    const controller = new AbortController()
    setSources(null)
    setError('')
    void loadMemorySources(workspaceId, memoryId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSources(result.sources)
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => controller.abort()
  }, [workspaceId, memoryId, open, refresh])
  return (
    <details className="memory-sources" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{zh ? '查看来源' : 'View sources'}</summary>
      {open ? (
        error ? (
          <p role="alert">
            {error}{' '}
            <button
              type="button"
              className="icon-btn"
              onClick={() => setRefresh((value) => value + 1)}
            >
              {zh ? '重试' : 'Retry'}
            </button>
          </p>
        ) : sources === null ? (
          <p role="status">{zh ? '正在读取来源…' : 'Loading sources…'}</p>
        ) : sources.length ? (
          <MemorySourceList sources={sources} />
        ) : (
          <p>{zh ? '没有已记录的来源。' : 'No sources recorded.'}</p>
        )
      ) : null}
    </details>
  )
}
