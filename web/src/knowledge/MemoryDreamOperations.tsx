import { Plus, Trash2 } from 'lucide-react'
import type { MemoryDreamGeneration } from '../../../src/shared/memory-dream-generation.js'
import {
  type MemoryDreamAction,
  type MemoryDreamOperation,
  type MemoryDreamSnapshot,
  type MemoryDreamValue,
  memoryDreamImpact,
} from '../../../src/shared/memory-dream-plan.js'
import {
  type TeamMemoryProcedureRefType,
  teamMemoryKinds,
  teamMemoryProcedureRefTypes,
  teamMemoryScopes,
} from '../../../src/shared/team-memory.js'
import { useI18n } from '../i18n.js'
import { MemoryDreamDiff } from './MemoryDreamDiff.js'
import { MemoryDreamCitations } from './MemoryDreamGeneration.js'

const emptyValue = (): MemoryDreamValue => ({
  body: '',
  kind: 'fact',
  scope: 'workspace',
  procedure_ref: null,
  tags: [],
})
export const invalidDreamOperations = (operations: MemoryDreamOperation[]) => {
  const touched = new Set<string>()
  return operations.some((op) => {
    if (op.action !== 'add')
      for (const source of op.sources) {
        if (touched.has(source.memory_id)) return true
        touched.add(source.memory_id)
      }
    return (
      (op.action === 'rewrite' && op.sources.length !== 1) ||
      (op.action === 'merge' && op.sources.length < 2) ||
      (op.action === 'archive' && !op.sources.length) ||
      (op.action !== 'archive' &&
        (!op.result?.body.trim() ||
          (op.result.kind === 'procedure_ref' && !op.result.procedure_ref?.id.trim())))
    )
  })
}
export const MemoryDreamOperations = ({
  operations,
  snapshots,
  disabled,
  messages = [],
  onChange,
}: {
  operations: MemoryDreamOperation[]
  snapshots: MemoryDreamSnapshot[]
  disabled: boolean
  messages?: MemoryDreamGeneration['input']['messages']
  onChange: (operations: MemoryDreamOperation[]) => void
}) => {
  const { t, language } = useI18n()
  const zh = language === 'zh'
  const actions = zh
    ? { add: '新增', rewrite: '改写', merge: '合并', archive: '归档' }
    : { add: 'Add', rewrite: 'Rewrite', merge: 'Merge', archive: 'Archive' }
  const impact = memoryDreamImpact(operations)
  const patch = (id: string, change: Partial<MemoryDreamOperation>) =>
    onChange(operations.map((op) => (op.id === id ? { ...op, ...change } : op)))
  return (
    <div className="memory-dream-operations">
      <p role="status">
        {zh
          ? `将修改 ${impact.touched_memory_ids.length} 条现有记忆，新增 ${impact.created_count} 条。`
          : `Will change ${impact.touched_memory_ids.length} existing memories and create ${impact.created_count}.`}
      </p>
      <p className="text-ter">
        {zh
          ? '移除提案不会改动其来源。提交会应用当前显示的全部操作。'
          : 'Removing a proposal leaves its sources unchanged. Apply uses all operations shown here.'}
      </p>
      {operations.map((op, index) => {
        const selected = snapshots.filter((source) =>
          op.sources.some((ref) => ref.memory_id === source.memory_id)
        )
        const result = op.result
        const updateValue = (change: Partial<MemoryDreamValue>) =>
          patch(op.id, { result: { ...(result ?? emptyValue()), ...change } })
        return (
          <fieldset key={op.id} className="memory-dream-operation" disabled={disabled}>
            <legend>
              {zh ? '操作' : 'Operation'} {index + 1}
            </legend>
            <div className="memory-dream-fields">
              <label>
                {zh ? '操作类型' : 'Action'}
                <select
                  value={op.action}
                  onChange={(event) => {
                    const action = event.target.value as MemoryDreamAction
                    patch(op.id, {
                      action,
                      sources: action === 'rewrite' ? op.sources.slice(0, 1) : op.sources,
                      result: action === 'archive' ? null : (result ?? emptyValue()),
                    })
                  }}
                >
                  {Object.entries(actions).map(([action, label]) => (
                    <option key={action} value={action}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="icon-btn"
                onClick={() => onChange(operations.filter((item) => item.id !== op.id))}
                aria-label={`${zh ? '移除提案' : 'Remove proposal'} ${index + 1}`}
              >
                <Trash2 size={14} aria-hidden />
                {zh ? '移除提案' : 'Remove proposal'}
              </button>
            </div>
            <MemoryDreamCitations messages={messages} sequences={op.message_sources ?? []} />
            <details className="memory-dream-source-picker">
              <summary>
                {zh ? '选择来源' : 'Choose sources'} ({selected.length})
              </summary>
              <p>
                {op.action === 'add'
                  ? zh
                    ? '新增操作的来源仅供引用，不会被修改。'
                    : 'Sources for an add are references only; they remain unchanged.'
                  : zh
                    ? '改写须选 1 条，合并至少选 2 条，归档至少选 1 条。'
                    : 'Select one source for rewrite, at least two for merge, or at least one for archive.'}
              </p>
              {snapshots.map((source) => (
                <label key={source.memory_id}>
                  <input
                    type="checkbox"
                    checked={op.sources.some((ref) => ref.memory_id === source.memory_id)}
                    onChange={(event) =>
                      patch(op.id, {
                        sources: event.target.checked
                          ? [
                              ...op.sources,
                              {
                                memory_id: source.memory_id,
                                expected_revision: source.revision,
                                expected_hash: source.content_hash,
                              },
                            ]
                          : op.sources.filter((ref) => ref.memory_id !== source.memory_id),
                      })
                    }
                  />
                  <span>
                    {source.body}
                    <small>
                      {source.memory_id} · v{source.revision}
                    </small>
                  </span>
                </label>
              ))}
            </details>
            {result ? (
              <>
                <div className="memory-dream-fields">
                  <label>
                    {t('memory.kindAria')}
                    <select
                      value={result.kind}
                      onChange={(event) =>
                        updateValue({
                          kind: event.target.value as MemoryDreamValue['kind'],
                          procedure_ref:
                            event.target.value === 'procedure_ref'
                              ? (result.procedure_ref ?? { type: 'workflow', id: '', title: null })
                              : null,
                        })
                      }
                    >
                      {teamMemoryKinds.map((kind) => (
                        <option value={kind} key={kind}>
                          {t(`memory.kind.${kind}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {zh ? '范围' : 'Scope'}
                    <select
                      value={result.scope}
                      onChange={(event) =>
                        updateValue({ scope: event.target.value as MemoryDreamValue['scope'] })
                      }
                    >
                      {teamMemoryScopes.map((scope) => (
                        <option key={scope} value={scope}>
                          {t(`memory.scope.${scope}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  {zh ? '结果内容' : 'Result body'}
                  <textarea
                    value={result.body}
                    maxLength={4000}
                    onChange={(event) => updateValue({ body: event.target.value })}
                  />
                </label>
                <label>
                  {zh ? '标签（逗号分隔）' : 'Tags (comma separated)'}
                  <input
                    value={result.tags.join(',')}
                    onChange={(event) => updateValue({ tags: event.target.value.split(',') })}
                  />
                </label>
                {result.kind === 'procedure_ref' ? (
                  <div className="memory-dream-fields">
                    <label>
                      {t('memory.procedureRef.typeLabel')}
                      <select
                        value={result.procedure_ref?.type ?? 'workflow'}
                        onChange={(event) =>
                          updateValue({
                            procedure_ref: {
                              id: result.procedure_ref?.id ?? '',
                              title: result.procedure_ref?.title ?? null,
                              type: event.target.value as TeamMemoryProcedureRefType,
                            },
                          })
                        }
                      >
                        {teamMemoryProcedureRefTypes.map((type) => (
                          <option key={type} value={type}>
                            {t(`memory.procedureRef.type.${type}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t('memory.procedureRef.idLabel')}
                      <input
                        maxLength={256}
                        value={result.procedure_ref?.id ?? ''}
                        onChange={(event) =>
                          updateValue({
                            procedure_ref: {
                              type: result.procedure_ref?.type ?? 'workflow',
                              title: result.procedure_ref?.title ?? null,
                              id: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      {t('memory.procedureRef.titleLabel')}
                      <input
                        maxLength={160}
                        value={result.procedure_ref?.title ?? ''}
                        onChange={(event) =>
                          updateValue({
                            procedure_ref: {
                              type: result.procedure_ref?.type ?? 'workflow',
                              id: result.procedure_ref?.id ?? '',
                              title: event.target.value || null,
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                ) : null}
              </>
            ) : null}
            {op.action !== 'add'
              ? selected.map((source) => (
                  <MemoryDreamDiff
                    key={source.memory_id}
                    memoryId={source.memory_id}
                    before={source}
                    after={
                      op.action === 'rewrite' && result
                        ? { ...source, ...result }
                        : { ...source, status: 'archived' }
                    }
                  />
                ))
              : null}
            {(op.action === 'add' || op.action === 'merge') && result ? (
              <MemoryDreamDiff
                before={null}
                after={{
                  ...result,
                  status: 'active',
                  pinned: op.action === 'merge' && selected.some((source) => source.pinned),
                }}
              />
            ) : null}
          </fieldset>
        )
      })}
      {invalidDreamOperations(operations) ? (
        <p role="alert">
          {zh
            ? '请补全结果与来源数量；每条记忆只能被一个操作修改。'
            : 'Complete the result and required sources. Each memory can be changed by only one operation.'}
        </p>
      ) : null}
      <button
        type="button"
        className="icon-btn"
        disabled={disabled || operations.length >= 50}
        onClick={() =>
          onChange([
            ...operations,
            { id: crypto.randomUUID(), action: 'add', sources: [], result: emptyValue() },
          ])
        }
      >
        <Plus size={14} aria-hidden />
        {zh ? '新增提案' : 'Add proposal'}
      </button>
    </div>
  )
}
