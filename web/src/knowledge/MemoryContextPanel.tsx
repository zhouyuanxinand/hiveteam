import { useState } from 'react'
import type { MemoryContextSnapshot } from '../../../src/shared/memory-context.js'
import { apiFetch } from '../api.js'
import { useI18n } from '../i18n.js'

export const MemoryContextPanel = ({ workspaceId }: { workspaceId: string }) => {
  const { language } = useI18n(),
    zh = language === 'zh'
  const [contexts, setContexts] = useState<MemoryContextSnapshot[]>([])
  const [budget, setBudget] = useState(1500),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const load = async () => {
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/contexts`)
      if (!response.ok) throw new Error('Unable to load context history')
      const result = await response.json()
      setContexts(result.contexts)
      setBudget(result.budget)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details
      className="memory-context-panel"
      onToggle={(event) => {
        if (event.currentTarget.open) void load()
      }}
    >
      <summary>{zh ? '上下文注入记录与预算' : 'Context history and budget'}</summary>
      <p>
        {zh
          ? '记录已准备的上下文，不代表模型已经读取或完成任务。其它工作区的记忆按权限排除。'
          : 'Records prepared context, not proof that a model read it or completed work. Other workspaces are excluded by scope.'}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          void apiFetch(`/api/ui/workspaces/${workspaceId}/memory/budget`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ budget }),
          })
            .then(async (response) => {
              if (!response.ok) throw new Error((await response.json()).error)
              setError('')
            })
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false))
        }}
      >
        <label>
          {zh ? '字符预算（600–8000）' : 'Character budget (600–8000)'}{' '}
          <input
            type="number"
            min={600}
            max={8000}
            step={1}
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
          />
        </label>{' '}
        <button type="submit" className="icon-btn" disabled={busy}>
          {zh ? '保存预算' : 'Save budget'}
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {!contexts.length ? (
        <p>{zh ? '尚无注入记录。' : 'No context recorded yet.'}</p>
      ) : (
        contexts.map((context) => (
          <details key={context.id}>
            <summary>
              {context.context} · {context.dispatch_id ?? context.run_id ?? context.agent_id} ·{' '}
              {context.used_chars}/{context.budget}
            </summary>
            <ul>
              {context.candidates.map((candidate) => (
                <li key={candidate.memory_id}>
                  <code>{candidate.memory_id}</code> r{candidate.revision} ·{' '}
                  {candidate.selected ? (zh ? '选中' : 'selected') : zh ? '未选中' : 'excluded'} ·{' '}
                  {candidate.injected_chars} {zh ? '字符' : 'chars'}
                  <p>
                    {candidate.reasons.join(', ')}
                    {candidate.memory_changed ? ' · memory_changed' : ''}
                    {candidate.sources.some((source) => source.stale) ? ' · stale_source' : ''}
                  </p>
                  <small>
                    {candidate.hits.map((hit) => `${hit.field}:${hit.token}`).join(', ')}
                  </small>
                </li>
              ))}
            </ul>
            <details>
              <summary>{zh ? '查看当时准备的内容' : 'View prepared content'}</summary>
              <pre>{context.digest}</pre>
            </details>
          </details>
        ))
      )}
    </details>
  )
}
